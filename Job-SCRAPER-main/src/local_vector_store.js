/**
 * LOCAL VECTOR STORE — Drop-in ChromaDB replacement (CommonJS)
 * Uses TF-IDF cosine similarity, no server required.
 * Persists collections to data/vector_store.json
 */

const fs = require("fs");
const path = require("path");

const STORE_PATH = path.join(__dirname, "..", "data", "vector_store.json");

// ── Text utilities ───────────────────────────────────────────────────────────

function tokenize(text) {
  return text.toLowerCase().split(/\W+/).filter(w => w.length > 2);
}

function buildIdf(documents) {
  const N = documents.length;
  const df = {};
  for (const doc of documents) {
    const seen = new Set(tokenize(doc));
    for (const t of seen) df[t] = (df[t] || 0) + 1;
  }
  const idf = {};
  for (const t in df) idf[t] = Math.log((N + 1) / (df[t] + 1)) + 1;
  return idf;
}

function tfidfVector(text, idf) {
  const tokens = tokenize(text);
  const tf = {};
  for (const t of tokens) tf[t] = (tf[t] || 0) + 1;
  const maxFreq = Math.max(...Object.values(tf), 1);
  const vec = {};
  for (const t in tf) {
    vec[t] = (tf[t] / maxFreq) * (idf[t] || 1);
  }
  return vec;
}

function cosineSimilarity(v1, v2) {
  let dot = 0, mag1 = 0, mag2 = 0;
  for (const t in v1) {
    dot += v1[t] * (v2[t] || 0);
    mag1 += v1[t] * v1[t];
  }
  for (const t in v2) mag2 += v2[t] * v2[t];
  if (mag1 === 0 || mag2 === 0) return 0;
  return dot / (Math.sqrt(mag1) * Math.sqrt(mag2));
}

// ── Persistence ──────────────────────────────────────────────────────────────

function loadStore() {
  if (fs.existsSync(STORE_PATH)) {
    return JSON.parse(fs.readFileSync(STORE_PATH, "utf-8"));
  }
  return {};
}

function saveStore(store) {
  fs.writeFileSync(STORE_PATH, JSON.stringify(store, null, 2));
}

// ── Collection ───────────────────────────────────────────────────────────────

class Collection {
  constructor(name, store) {
    this.name = name;
    this._store = store;
  }

  get _data() { return this._store[this.name]; }

  async add({ ids, documents, metadatas }) {
    for (let i = 0; i < ids.length; i++) {
      this._data.items[ids[i]] = {
        id: ids[i],
        document: documents[i],
        metadata: metadatas ? metadatas[i] : {}
      };
    }
    saveStore(this._store);
  }

  async update({ ids, documents, metadatas }) {
    await this.add({ ids, documents, metadatas });
  }

  async query({ queryTexts, nResults, where }) {
    const queryText = queryTexts[0];
    let items = Object.values(this._data.items);

    if (where) {
      items = items.filter(item =>
        Object.entries(where).every(([k, v]) => item.metadata[k] === v)
      );
    }

    if (items.length === 0) {
      return { ids: [[]], documents: [[]], metadatas: [[]], distances: [[]] };
    }

    const allDocs = items.map(i => i.document);
    const idf = buildIdf(allDocs);
    const docVectors = allDocs.map(d => tfidfVector(d, idf));
    const qVec = tfidfVector(queryText, idf);

    const scored = items.map((item, i) => ({
      item,
      distance: 1 - cosineSimilarity(qVec, docVectors[i])
    }));

    scored.sort((a, b) => a.distance - b.distance);
    const top = scored.slice(0, nResults);

    return {
      ids: [top.map(s => s.item.id)],
      documents: [top.map(s => s.item.document)],
      metadatas: [top.map(s => s.item.metadata)],
      distances: [top.map(s => s.distance)]
    };
  }
}

// ── ChromaClient (same interface as chromadb package) ────────────────────────

class ChromaClient {
  constructor() {
    this._store = loadStore();
  }

  async deleteCollection({ name }) {
    delete this._store[name];
    saveStore(this._store);
  }

  async createCollection({ name, metadata }) {
    this._store[name] = { metadata: metadata || {}, items: {} };
    saveStore(this._store);
    return new Collection(name, this._store);
  }

  async getCollection({ name }) {
    if (!this._store[name]) {
      throw new Error(`Collection '${name}' not found. Run: npm run setup`);
    }
    return new Collection(name, this._store);
  }
}

module.exports = { ChromaClient };
