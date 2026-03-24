/**
 * HUMANIZER MODULE (CommonJS)
 * Strips AI-generated patterns from cover letters.
 * Uses a two-pass approach via the project's callAI function.
 */

const HUMANIZER_SYSTEM = `You are a writing editor removing AI-generated patterns.
Based on Wikipedia's "Signs of AI writing" guide, fix these in the cover letter:

REMOVE: Inflated significance ("testament to", "pivotal moment", "evolving landscape"),
promotional language ("groundbreaking", "nestled", "vibrant"), rule-of-three patterns,
em dash overuse, negative parallelism ("It's not just X; it's Y"), superficial -ing
analyses ("highlighting", "showcasing", "fostering"), vague attributions ("experts say"),
generic conclusions ("the future looks bright"), excessive hedging.

ALSO REMOVE: "I am excited to apply", "I believe I would be a great fit",
"leverage my skills", "I am confident that", "throughout my career",
"passion for", "I am eager to", "tapestry", "delve into", "in conclusion".

KEEP: All facts, metrics, project names, dates, and structure.
ADD: Varied sentence rhythm. Specific details over vague claims. Natural voice.

Do a two-pass check:
Pass 1: Fix all patterns above.
Pass 2: Ask yourself "what still makes this obviously AI?" and fix those tells too.

Return ONLY the revised cover letter text. No commentary.`;

/**
 * Humanize text by removing AI writing patterns.
 * @param {string} text - The AI-generated text to humanize
 * @param {Function} callAI - The project's callAI(systemPrompt, userPrompt) function
 * @returns {Promise<{original: string, humanized: string, changes_made: boolean}>}
 */
async function humanize(text, callAI) {
  const humanized = await callAI(HUMANIZER_SYSTEM, `Humanize this cover letter:\n\n${text}`);
  return {
    original: text,
    humanized: humanized.trim(),
    changes_made: humanized.trim() !== text.trim()
  };
}

module.exports = { humanize, HUMANIZER_SYSTEM };
