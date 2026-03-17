/**
 * RAG RETRIEVAL ENGINE (CommonJS)
 * Takes a job posting, queries the local vector store,
 * returns best-matching skill chunks, projects, and work experience.
 */

const { ChromaClient } = require("./local_vector_store");

let client = null;
let collections = {};

async function getClient() {
  if (!client) {
    client = new ChromaClient();
    collections.skills = await client.getCollection({ name: "skill_chunks" });
    collections.projects = await client.getCollection({ name: "projects" });
    collections.work = await client.getCollection({ name: "work_experience" });
  }
  return collections;
}

/**
 * Retrieve the most relevant chunks for a given job posting.
 */
async function retrieveContext(jobText, options = {}) {
  const {
    topSkills = 10,
    topProjects = 3,
    topWork = 2,
    categoryFilter = null
  } = options;

  const cols = await getClient();

  const skillQuery = { queryTexts: [jobText], nResults: topSkills };
  if (categoryFilter) {
    skillQuery.where = { category: categoryFilter };
  }

  const [skillResults, projResults, workResults] = await Promise.all([
    cols.skills.query(skillQuery),
    cols.projects.query({ queryTexts: [jobText], nResults: topProjects }),
    cols.work.query({ queryTexts: [jobText], nResults: topWork })
  ]);

  const skills = skillResults.ids[0].map((id, i) => ({
    id,
    document: skillResults.documents[0][i],
    metadata: skillResults.metadatas[0][i],
    distance: skillResults.distances[0][i],
    relevance: Math.max(0, (1 - skillResults.distances[0][i]) * 100).toFixed(1) + "%"
  }));

  const projects = projResults.ids[0].map((id, i) => ({
    id,
    document: projResults.documents[0][i],
    metadata: projResults.metadatas[0][i],
    distance: projResults.distances[0][i]
  }));

  const work = workResults.ids[0].map((id, i) => ({
    id,
    document: workResults.documents[0][i],
    metadata: workResults.metadatas[0][i],
    distance: workResults.distances[0][i]
  }));

  return {
    skills,
    projects,
    work,
    metadata: {
      query_length: jobText.length,
      skills_retrieved: skills.length,
      projects_retrieved: projects.length,
      work_retrieved: work.length,
      timestamp: new Date().toISOString()
    }
  };
}

/**
 * Add a new skill chunk to the vector store.
 */
async function addSkillToVector(chunk) {
  const cols = await getClient();
  await cols.skills.add({
    ids: [chunk.id],
    documents: [`${chunk.skill}. Level: ${chunk.level}. ${chunk.evidence}`],
    metadatas: [{
      category: chunk.category,
      level: chunk.level,
      skill_name: chunk.skill,
      phase: String(chunk.phase),
      added_date: chunk.added_date || new Date().toISOString().split("T")[0]
    }]
  });
}

/**
 * Update an existing skill chunk in the vector store.
 */
async function updateSkillInVector(chunk) {
  const cols = await getClient();
  await cols.skills.update({
    ids: [chunk.id],
    documents: [`${chunk.skill}. Level: ${chunk.level}. ${chunk.evidence}`],
    metadatas: [{
      category: chunk.category,
      level: chunk.level,
      skill_name: chunk.skill,
      phase: String(chunk.phase),
      added_date: chunk.last_updated || new Date().toISOString().split("T")[0]
    }]
  });
}

module.exports = { retrieveContext, addSkillToVector, updateSkillInVector };
