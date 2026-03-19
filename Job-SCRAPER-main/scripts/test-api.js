require("dotenv").config();

async function testAnthropicKey() {
  const key = process.env.ANTHROPIC_API_KEY;
  const model = process.env.CLAUDE_MODEL || "claude-sonnet-4-20250514";

  if (!key) {
    console.error("ANTHROPIC_API_KEY not set in .env");
    process.exit(1);
  }

  console.log(`Testing Anthropic API key: ${key.substring(0, 12)}...${key.slice(-4)}`);
  console.log(`Model: ${model}`);

  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": key,
        "anthropic-version": "2023-06-01"
      },
      body: JSON.stringify({
        model,
        max_tokens: 50,
        messages: [{ role: "user", content: "Say 'API key works!' in exactly 3 words." }]
      })
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      console.error(`API Error ${res.status}:`, err.error?.message || JSON.stringify(err));
      process.exit(1);
    }

    const data = await res.json();
    console.log(`Response: ${data.content[0].text}`);
    console.log("API key is valid!");
  } catch (err) {
    console.error("Connection error:", err.message);
    process.exit(1);
  }
}

testAnthropicKey();
