import OpenAI from "openai";

let client;

function getClient() {
  if (!process.env.OPENAI_API_KEY) {
    throw new Error("OPENAI_API_KEY is missing from the server environment.");
  }

  if (!client) {
    client = new OpenAI({
      apiKey: process.env.OPENAI_API_KEY,
    });
  }

  return client;
}

export async function generateText({
  system,
  prompt,
  model = "gpt-5.5",
}) {
  const openai = getClient();

  const response = await openai.responses.create({
    model,
    instructions: system,
    input: prompt,
  });

  const text = response.output_text?.trim();

  if (!text) {
    throw new Error("OpenAI returned an empty response.");
  }

  return text;
}