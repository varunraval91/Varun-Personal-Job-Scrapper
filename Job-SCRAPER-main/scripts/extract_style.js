/**
 * ONE-TIME STYLE EXTRACTION
 * Reads all PDF cover letters, analyzes writing patterns,
 * saves writing_style_profile.json. Run once, then never again.
 *
 * Usage: node extract_style.js
 */

const fs = require("fs");
const path = require("path");
const pdfParse = require("pdf-parse");

const CL_DIR = path.join(__dirname, "library", "foundation", "cover_letters");
const OUT_PATH = path.join(__dirname, "data", "writing_style_profile.json");

async function extractText(filePath) {
  const buf = fs.readFileSync(filePath);
  const data = await pdfParse(buf);
  return data.text.trim();
}

function getSentences(text) {
  return text
    .replace(/\n+/g, " ")
    .split(/(?<=[.!?])\s+/)
    .map(s => s.trim())
    .filter(s => s.length > 10);
}

function getWords(text) {
  return text.toLowerCase().replace(/[^a-z\s'-]/g, " ").split(/\s+/).filter(w => w.length > 2);
}

function getParagraphs(text) {
  return text.split(/\n{2,}/).map(p => p.trim()).filter(p => p.length > 30);
}

function getFirstSentence(text) {
  // Skip header lines (date, address, "Dear...") and get first real sentence
  const lines = text.split("\n").map(l => l.trim()).filter(Boolean);
  for (const line of lines) {
    if (/^(Dear |Sehr |Date|Varun|raval|linkedin|github|Phone|Email|Walldorf|Heidelberg|Mannheim|Position|Req|Location)/i.test(line)) continue;
    if (line.length < 20) continue;
    // This is likely the first real sentence of the body
    const sentences = getSentences(line);
    if (sentences.length > 0) return sentences[0];
  }
  return null;
}

function getClosingSentence(text) {
  const lines = text.split("\n").map(l => l.trim()).filter(Boolean);
  // Walk backwards, skip sign-off lines
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (/^(Best regards|Kind regards|Sincerely|Varun|raval|linkedin|github|Phone|Email|I am open)/i.test(line)) continue;
    if (line.length < 20) continue;
    // Check if it's the closing availability/thank-you line
    const sentences = getSentences(line);
    if (sentences.length > 0) return sentences[sentences.length - 1];
  }
  return null;
}

async function main() {
  console.log("Reading PDF cover letters from:", CL_DIR);

  const files = fs.readdirSync(CL_DIR).filter(f => f.toLowerCase().endsWith(".pdf"));
  console.log(`Found ${files.length} PDF files\n`);

  const rawSamples = [];
  const allTexts = [];

  for (const file of files) {
    const filePath = path.join(CL_DIR, file);
    try {
      const text = await extractText(filePath);
      if (text.length < 50) {
        console.log(`  SKIP (too short): ${file} (${text.length} chars)`);
        continue;
      }
      const wordCount = getWords(text).length;
      console.log(`  OK: ${file} (${wordCount} words)`);
      rawSamples.push({ filename: file, full_text: text, word_count: wordCount });
      allTexts.push(text);
    } catch (err) {
      console.log(`  FAIL: ${file} — ${err.message}`);
    }
  }

  console.log(`\nSuccessfully extracted: ${rawSamples.length} cover letters`);

  // ── Analysis ──────────────────────────────────────────────────

  // Sentence lengths
  const allSentences = allTexts.flatMap(getSentences);
  const avgSentenceLength = Math.round(
    allSentences.reduce((sum, s) => sum + getWords(s).length, 0) / allSentences.length
  );

  // Paragraph lengths
  const allParagraphs = allTexts.flatMap(getParagraphs);
  const avgParagraphLength = Math.round(
    allParagraphs.reduce((sum, p) => sum + getWords(p).length, 0) / allParagraphs.length
  );

  // Average cover letter word count
  const avgCoverLetterWords = Math.round(
    rawSamples.reduce((sum, s) => sum + s.word_count, 0) / rawSamples.length
  );

  // Opening patterns (first real sentence from each CL)
  const openingPatterns = allTexts
    .map(getFirstSentence)
    .filter(Boolean)
    .filter((v, i, a) => a.indexOf(v) === i); // unique

  // Closing patterns
  const closingPatterns = allTexts
    .map(getClosingSentence)
    .filter(Boolean)
    .filter((v, i, a) => a.indexOf(v) === i);

  // Word frequency analysis
  const wordFreq = {};
  const STOPWORDS = new Set([
    "the", "and", "for", "are", "but", "not", "you", "all", "can", "was",
    "one", "our", "out", "had", "has", "his", "how", "its", "may", "new",
    "now", "see", "way", "who", "did", "get", "let", "say", "she", "too",
    "use", "with", "this", "that", "from", "they", "been", "have", "many",
    "some", "them", "than", "will", "each", "make", "like", "over", "such",
    "into", "year", "also", "back", "your", "work", "about", "would",
    "there", "their", "which", "could", "other", "after", "first", "well",
    "just", "where", "what", "when", "being", "should", "through", "these",
    "more", "very", "most", "both", "during", "dear", "hiring", "manager",
    "best", "regards", "varun", "raval", "thank", "sincerely", "position",
    "application"
  ]);

  for (const text of allTexts) {
    for (const word of getWords(text)) {
      if (!STOPWORDS.has(word) && word.length > 3) {
        wordFreq[word] = (wordFreq[word] || 0) + 1;
      }
    }
  }

  const sortedWords = Object.entries(wordFreq).sort((a, b) => b[1] - a[1]);
  const usesOften = sortedWords.slice(0, 30).map(([w]) => w);

  // Find signature phrases (2-3 word combos that appear in 3+ CLs)
  const phraseCount = {};
  for (const text of allTexts) {
    const words = getWords(text);
    const seenInDoc = new Set();
    for (let i = 0; i < words.length - 1; i++) {
      const bigram = words[i] + " " + words[i + 1];
      if (!seenInDoc.has(bigram)) {
        seenInDoc.add(bigram);
        phraseCount[bigram] = (phraseCount[bigram] || 0) + 1;
      }
    }
    for (let i = 0; i < words.length - 2; i++) {
      const trigram = words[i] + " " + words[i + 1] + " " + words[i + 2];
      if (!seenInDoc.has(trigram)) {
        seenInDoc.add(trigram);
        phraseCount[trigram] = (phraseCount[trigram] || 0) + 1;
      }
    }
  }

  const signaturePhrases = Object.entries(phraseCount)
    .filter(([, count]) => count >= 3)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 20)
    .map(([phrase]) => phrase);

  // Words Varun avoids (common AI filler that doesn't appear in his writing)
  const aiWords = [
    "excited", "passionate", "leverage", "synergy", "innovative",
    "cutting-edge", "groundbreaking", "testament", "landscape",
    "tapestry", "nestled", "delve", "eager", "thrilled", "confident"
  ];
  const avoids = aiWords.filter(w => !wordFreq[w]);

  // Structural pattern analysis
  const structuralPattern = analyzeStructure(allTexts);

  // Tone description
  const toneDescription = buildToneDescription(avgSentenceLength, avgCoverLetterWords, usesOften);

  // ── Build profile ─────────────────────────────────────────────

  const profile = {
    extracted_from: rawSamples.map(s => s.filename),
    extraction_date: new Date().toISOString().split("T")[0],
    total_samples: rawSamples.length,
    style_analysis: {
      avg_sentence_length: avgSentenceLength,
      avg_paragraph_length: avgParagraphLength,
      avg_cover_letter_words: avgCoverLetterWords,
      opening_patterns: openingPatterns,
      closing_patterns: closingPatterns,
      signature_phrases: signaturePhrases,
      vocabulary_preferences: {
        uses_often: usesOften,
        avoids: avoids
      },
      tone_description: toneDescription,
      structural_pattern: structuralPattern
    },
    raw_samples: rawSamples
  };

  fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });
  fs.writeFileSync(OUT_PATH, JSON.stringify(profile, null, 2));

  console.log(`\n[OK] Style profile extracted from ${rawSamples.length} cover letters → data/writing_style_profile.json`);
  console.log(`[OK] PDFs will not be accessed again`);
  console.log(`\n--- Style Analysis Summary ---`);
  console.log(`  Avg sentence length: ${avgSentenceLength} words`);
  console.log(`  Avg paragraph length: ${avgParagraphLength} words`);
  console.log(`  Avg cover letter: ${avgCoverLetterWords} words`);
  console.log(`  Opening patterns: ${openingPatterns.length}`);
  console.log(`  Closing patterns: ${closingPatterns.length}`);
  console.log(`  Signature phrases: ${signaturePhrases.length}`);
  console.log(`  Tone: ${toneDescription}`);
}

function analyzeStructure(texts) {
  // Look for common paragraph ordering across CLs
  const patterns = [];
  for (const text of texts) {
    const paras = getParagraphs(text);
    const labels = paras.map(p => {
      const lower = p.toLowerCase();
      if (/^(dear|sehr)/i.test(p)) return "salutation";
      if (/master|m\.sc|programme|studies|coursework|university|hochschule/i.test(p) && paras.indexOf(p) <= 2) return "academic_connection";
      if (/project|built|developed|implemented|automated|pipeline/i.test(p)) return "project_evidence";
      if (/sap|walldorf|working student|intern|btp|fiori|hana/i.test(p) && /experience|worked|role/i.test(p)) return "work_experience";
      if (/collaborat|communicat|team|cross-functional|present|stakeholder/i.test(p)) return "soft_skills";
      if (/available|availab|april|march|semester|full-time|hours\/month/i.test(p)) return "availability";
      if (/thank|regards|sincerely/i.test(p)) return "closing";
      return "body";
    });
    patterns.push(labels.filter(l => l !== "salutation" && l !== "closing").join(" → "));
  }

  // Most common pattern
  const patternFreq = {};
  for (const p of patterns) patternFreq[p] = (patternFreq[p] || 0) + 1;
  const topPattern = Object.entries(patternFreq).sort((a, b) => b[1] - a[1])[0];

  return topPattern
    ? `Most common structure (${topPattern[1]}/${texts.length} CLs): ${topPattern[0]}`
    : "Opens with role connection, then academic/project evidence, then availability";
}

function buildToneDescription(avgSentLen, avgWords, topWords) {
  const parts = [];

  if (avgSentLen <= 15) parts.push("Concise and direct");
  else if (avgSentLen <= 20) parts.push("Moderately detailed with balanced sentence structure");
  else parts.push("Detailed and explanatory");

  if (avgWords <= 300) parts.push("compact cover letters that stay under one page");
  else if (avgWords <= 400) parts.push("focused cover letters targeting one page");
  else parts.push("thorough cover letters using full page space");

  if (topWords.includes("experience") || topWords.includes("working")) {
    parts.push("emphasizes practical hands-on experience over theoretical knowledge");
  }

  return parts.join(". ") + ".";
}

main().catch(err => {
  console.error("Style extraction failed:", err);
  process.exit(1);
});
