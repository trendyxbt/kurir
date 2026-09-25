// Day 2 QA, L3. Preloaded into the server process (node --import). Intercepts every call to
// api.openai.com, logs it, and returns a canned sentence. Nothing leaves the machine and nothing
// is billed, so we can count exactly which /guard verdicts reach the LLM step.
const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  if (String(input).includes("api.openai.com")) {
    console.log("[qa-llm-spy] OpenAI call intercepted");
    return new Response(JSON.stringify({ choices: [{ message: { content: "[qa-spy sentence]" } }] }), { status: 200 });
  }
  return realFetch(input, init);
};
