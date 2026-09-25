// Day 2 QA, L3. Preloaded into the server process (node --import). Intercepts every LLM call —
// api.openai.com AND whatever LLM_BASE_URL points at — logs it, and returns a canned sentence.
// Nothing leaves the machine and nothing is billed, so we can count exactly which /guard verdicts
// reach the LLM step. (Widened after llmExplain gained LLM_BASE_URL support: an OpenAI-only spy
// would let calls to a custom endpoint slip past and make L3 pass falsely with 0 calls.)
const realFetch = globalThis.fetch;
const llmHosts = ["api.openai.com"];
if (process.env.LLM_BASE_URL) llmHosts.push(new URL(process.env.LLM_BASE_URL).host);
globalThis.fetch = async (input, init) => {
  const url = String(input instanceof Request ? input.url : input);
  if (llmHosts.some((h) => url.includes(h))) {
    console.log(`[qa-llm-spy] LLM call intercepted → ${new URL(url).host}`);
    return new Response(JSON.stringify({ choices: [{ message: { content: "[qa-spy sentence]" } }] }), { status: 200 });
  }
  return realFetch(input, init);
};
