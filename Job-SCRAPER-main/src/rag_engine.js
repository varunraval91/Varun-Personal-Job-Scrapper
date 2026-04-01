/**
 * RAG RETRIEVAL ENGINE (CommonJS) — v4.0
 * Uses vector_text for richer TF-IDF indexing.
 * Supports junction-table enrichment: JD → skill match → linked projects/work.
 */

const { ChromaClient } = require("./local_vector_store");

let client = null;
let collections = {};

async function getClient() {
  if (!client) {
    client = new ChromaClient();
    collections.skills  = await client.getCollection({ name: "skill_chunks" });
    collections.projects = await client.getCollection({ name: "projects" });
    collections.work    = await client.getCollection({ name: "work_experience" });
  }
  return collections;
}

/**
 * Retrieve the most relevant chunks for a given job posting.
 * If `bank` (v4.0) is supplied, junction tables are used to resolve
 * linked projects/work from matched skills instead of independent TF-IDF.
 */
async function retrieveContext(jobText, options = {}, bank = null) {
  const {
    topSkills   = 10,
    topProjects = 3,
    topWork     = 2,
    categoryFilter = null
  } = options;

  const cols = await getClient();

  const skillQuery = { queryTexts: [jobText], nResults: topSkills };
  if (categoryFilter) skillQuery.where = { category: categoryFilter };

  const [skillResults, projResults, workResults] = await Promise.all([
    cols.skills.query(skillQuery),
    cols.projects.query({ queryTexts: [jobText], nResults: topProjects }),
    cols.work.query({ queryTexts: [jobText], nResults: topWork })
  ]);

  const skills = skillResults.ids[0].map((id, i) => ({
    id,
    document:  skillResults.documents[0][i],
    metadata:  skillResults.metadatas[0][i],
    distance:  skillResults.distances[0][i],
    relevance: Math.max(0, (1 - skillResults.distances[0][i]) * 100).toFixed(1) + "%"
  }));

  let projects = projResults.ids[0].map((id, i) => ({
    id,
    document: projResults.documents[0][i],
    metadata: projResults.metadatas[0][i],
    distance: projResults.distances[0][i]
  }));

  let work = workResults.ids[0].map((id, i) => ({
    id,
    document: workResults.documents[0][i],
    metadata: workResults.metadatas[0][i],
    distance: workResults.distances[0][i]
  }));

  // ── Junction-table enrichment (v4.0) ──────────────────────────────────────
  if (bank && bank.skill_project && bank.skill_work) {
    const topSkillIds = new Set(skills.map(s => s.id));

    // Count how many top skills link to each project/work (relevance score)
    const projScore = {};
    const workScore = {};
    for (const j of bank.skill_project) {
      if (topSkillIds.has(j.skill_id))
        projScore[j.project_id] = (projScore[j.project_id] || 0) + 1;
    }
    for (const j of bank.skill_work) {
      if (topSkillIds.has(j.skill_id))
        workScore[j.work_id] = (workScore[j.work_id] || 0) + 1;
    }

    const bankProjects = bank.user_projects || [];
    const bankWork     = bank.user_work_experience || [];

    const linkedProjects = bankProjects
      .filter(p => projScore[p.project_id])
      .sort((a, b) => projScore[b.project_id] - projScore[a.project_id])
      .slice(0, topProjects);

    const linkedWork = bankWork
      .filter(w => workScore[w.work_id])
      .sort((a, b) => workScore[b.work_id] - workScore[a.work_id])
      .slice(0, topWork);

    if (linkedProjects.length > 0) {
      projects = linkedProjects.map(p => ({
        id:       p.project_id,
        document: p.vector_text || `${p.project_name} (${p.tech}): ${p.description}`,
        metadata: { name: p.project_name, tech: p.tech }
      }));
    }
    if (linkedWork.length > 0) {
      work = linkedWork.map(w => ({
        id:       w.work_id,
        document: w.vector_text || `${w.job_title} at ${w.company}: ${(w.responsibilities || []).join(" ")}`,
        metadata: { title: w.job_title, company: w.company, period: w.period, skills_used: w.skills_used || [] }
      }));
    }
  }

  return {
    skills,
    projects,
    work,
    metadata: {
      query_length:      jobText.length,
      skills_retrieved:  skills.length,
      projects_retrieved: projects.length,
      work_retrieved:    work.length,
      junction_enriched: !!(bank && bank.skill_project),
      timestamp:         new Date().toISOString()
    }
  };
}

/**
 * Rebuild the entire vector store from a v4.0 bank object.
 * Drops and recreates all three collections using vector_text.
 */
async function rebuildVectorStore(bank) {
  const freshClient = new ChromaClient();

  for (const name of ["skill_chunks", "projects", "work_experience"]) {
    try { await freshClient.deleteCollection({ name }); } catch (_) {}
    await freshClient.createCollection({ name });
  }

  const skillColl = await freshClient.getCollection({ name: "skill_chunks" });
  const projColl  = await freshClient.getCollection({ name: "projects" });
  const workColl  = await freshClient.getCollection({ name: "work_experience" });

  // Skills — use skill_id or fall back to id
  const skills = bank.user_skills || bank.skill_chunks || [];
  for (const s of skills) {
    const id  = s.skill_id || s.id;
    const doc = s.vector_text || `${s.skill_name || s.skill}. Level: ${s.level}. ${s.description || s.evidence}`;
    await skillColl.add({
      ids:       [id],
      documents: [doc],
      metadatas: [{
        category:   s.category,
        level:      s.level,
        skill_name: s.skill_name || s.skill || "",
        phase:      String(s.phase || ""),
        type:       s.type || "skill"
      }]
    });
  }

  // Projects
  const projects = bank.user_projects || bank.projects || [];
  for (const p of projects) {
    const id  = p.project_id || p.id;
    const doc = p.vector_text || `${p.project_name || p.name} (${p.tech}): ${p.description}`;
    await projColl.add({
      ids:       [id],
      documents: [doc],
      metadatas: [{
        name:         p.project_name || p.name || "",
        tech:         p.tech || "",
        sub_category: p.sub_category || ""
      }]
    });
  }

  // Work experience
  const workList = bank.user_work_experience || bank.work_experience || [];
  for (const w of workList) {
    const id  = w.work_id || w.id;
    const doc = w.vector_text || `${w.job_title || w.title} at ${w.company}: ${(w.responsibilities || w.bullets || []).join(" ")}`;
    await workColl.add({
      ids:       [id],
      documents: [doc],
      metadatas: [{
        title:   w.job_title || w.title || "",
        company: w.company || "",
        period:  w.period  || ""
      }]
    });
  }

  // Reset cached client so next getClient() picks up the new store
  client = null;
  collections = {};

  return {
    skills:   skills.length,
    projects: projects.length,
    work:     workList.length
  };
}

/**
 * Add a new skill to the vector store.
 * Accepts both v4.0 (skill_id/skill_name/description) and v3.2 (id/skill/evidence) fields.
 */
async function addSkillToVector(chunk) {
  const cols = await getClient();
  const id        = chunk.skill_id  || chunk.id;
  const skillName = chunk.skill_name || chunk.skill;
  const desc      = chunk.description || chunk.evidence;
  const doc       = chunk.vector_text || `${skillName}. Level: ${chunk.level}. ${desc}`;
  await cols.skills.add({
    ids:       [id],
    documents: [doc],
    metadatas: [{
      category:   chunk.category,
      level:      chunk.level,
      skill_name: skillName,
      phase:      String(chunk.phase || ""),
      type:       chunk.type || "skill"
    }]
  });
}

/**
 * Update an existing skill in the vector store.
 */
async function updateSkillInVector(chunk) {
  const cols = await getClient();
  const id        = chunk.skill_id  || chunk.id;
  const skillName = chunk.skill_name || chunk.skill;
  const desc      = chunk.description || chunk.evidence;
  const doc       = chunk.vector_text || `${skillName}. Level: ${chunk.level}. ${desc}`;
  await cols.skills.update({
    ids:       [id],
    documents: [doc],
    metadatas: [{
      category:   chunk.category,
      level:      chunk.level,
      skill_name: skillName,
      phase:      String(chunk.phase || ""),
      type:       chunk.type || "skill"
    }]
  });
}

/**
 * Reset the cached client so the next call to getClient() rebuilds from disk.
 */
function resetClient() {
  client = null;
  collections = {};
}

module.exports = { retrieveContext, rebuildVectorStore, addSkillToVector, updateSkillInVector, resetClient };
