import dotenv from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";

dotenv.config({
  path: path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    "..",
    ".env"
  )
});

const API_KEY =
  process.env.GEMINI_API_KEY;

const API_URL =
  "https://generativelanguage.googleapis.com/v1beta/models/";

const MODEL = "gemini-3.5-flash-lite";

const REQUEST_TIMEOUT_MS = 120000;
const MAX_RETRIES = 2;

function extractJsonText(rawText) {
  if (!rawText) {
    return "";
  }

  const text = String(rawText).trim();

  const fencedMatch = text.match(
    /```(?:json)?\s*([\s\S]*?)\s*```/i
  );

  if (fencedMatch) {
    return fencedMatch[1].trim();
  }

  return text;
}

function isTransientStatus(status) {
  return [
    429,
    500,
    502,
    503,
    504
  ].includes(status);
}

async function callGemini(prompt, systemMessage) {
  if (!API_KEY) {
    throw new Error(
      "Gemini API key is missing. Set GEMINI_API_KEY in backend/.env"
    );
  }

  for (
    let attempt = 0;
    attempt <= MAX_RETRIES;
    attempt += 1
  ) {
    const controller = new AbortController();

    const timeoutId = setTimeout(
      () => controller.abort(),
      REQUEST_TIMEOUT_MS
    );

    try {
      const response = await fetch(
        `${API_URL}${MODEL}:generateContent`,
        {
        method: "POST",

        headers: {
          "Content-Type": "application/json",
          "x-goog-api-key": API_KEY
        },

        body: JSON.stringify({
          systemInstruction: {
            parts: [{ text: systemMessage }]
          },
          contents: [
            {
              role: "user",
              parts: [{ text: prompt }]
            }
          ],
          generationConfig: {
            responseMimeType: "application/json",
            maxOutputTokens: 2048,
            temperature: 0.2
          }
        }),

        signal: controller.signal
        }
      );

      const rawResponseText =
        await response.text();

      let responseJson;

      try {
        responseJson =
          JSON.parse(rawResponseText);
      } catch (error) {
        throw new Error(
          `Gemini API returned invalid JSON: ${rawResponseText.slice(
            0,
            500
          )}`,
          {
            cause: error
          }
        );
      }

      if (!response.ok) {
        const errorMessage =
          responseJson?.error?.message ||
          responseJson?.message ||
          `Gemini API error: ${response.status}`;

        if (
          isTransientStatus(response.status) &&
          attempt < MAX_RETRIES
        ) {
          console.warn(
            `Gemini transient error on attempt ${attempt + 1
            }: ${errorMessage}. Retrying...`
          );

          continue;
        }

        throw new Error(errorMessage);
      }

      const content =
        responseJson?.candidates?.[0]?.content?.parts
          ?.map((part) => part.text || "")
          .join("")
          .trim();

      if (!content) {
        throw new Error(
          "Gemini API response did not include message content."
        );
      }

      return content;
    } catch (error) {
      if (error.name === "AbortError") {
        if (attempt < MAX_RETRIES) {
          console.warn(
            `Gemini request timed out on attempt ${attempt + 1
            }. Retrying...`
          );

          continue;
        }

        throw new Error(
          `Gemini API request timed out after ${REQUEST_TIMEOUT_MS / 1000} seconds.`,
          { cause: error }
        );
      }

      throw error;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  throw new Error(
    "Gemini API verification failed after retries."
  );
}


// =========================================================
// VERIFY ITEM
// =========================================================

export async function verifyItem(item) {
  console.log(
    "Sending item to Gemini verification API..."
  );

  console.log(
    "Part Number:",
    item.partNumber
  );

  console.log(
    "Manufacturer:",
    item.manufacturer
  );

  console.log(
    "Component Type:",
    item.componentType
  );

const prompt = `
Verify the engineering component using the manufacturer and part number.

Return JSON only:
{
  "componentType": "string",
  "verifiedProperties": [
    {
      "name": "string",
      "existingValue": "string",
      "verifiedValue": "string",
      "status": "MATCH" | "MISMATCH" | "NOT_VERIFIED",
      "source": "string",
      "explanation": "string"
    }
  ]
}

Alias ID: ${item.aliasId}
Part Number: ${item.partNumber}
Manufacturer: ${item.manufacturer}
Component Type: ${item.componentType}
Properties: ${JSON.stringify(item.properties)}

Rules:
- Verify only the supplied properties.
- Return only relevant properties.
- Preserve existingValue exactly.
- For range-valued properties such as wire size in AWG, verify and return the complete range, including both endpoints; never replace a range with a single gauge value.
- Do not infer missing range endpoints. If the complete range cannot be reliably verified, return an empty verifiedValue, status NOT_VERIFIED, and explain that the full range could not be confirmed.
- If a property cannot be reliably verified, use NOT_VERIFIED.
- Do not invent specifications.
- Return JSON only.
`;

  const content = await callGemini(
    prompt,
    "You are a careful engineering data verifier. Return valid JSON only."
  );

  const jsonText =
    extractJsonText(content);

  try {
    return JSON.parse(jsonText);
  } catch (error) {
    console.error(
      "Failed to parse Gemini verification JSON:",
      jsonText
    );

    throw new Error(
      "Gemini verification response was not valid JSON.",
      {
        cause: error
      }
    );
  }
}


// =========================================================
// SUBCLASS IDENTIFICATION
// =========================================================

export async function identifySubclass(
  item,
  candidateSubclasses
) {
  if (
    !Array.isArray(candidateSubclasses) ||
    candidateSubclasses.length === 0
  ) {
    return {
      predictedSubclass: "",
      confidence: 0,
      candidates: [],
      reason:
        "No subclass candidates were available from the current Excel data."
    };
  }

  console.log(
    "Sending item for subclass identification..."
  );

  const prompt = `
Identify the most relevant subclass for this engineering component.

You are given a list of candidate subclasses extracted from the organization's existing data.

Use the component information to rank the candidate subclasses.

Return valid JSON only:

{
  "predictedSubclass": "string",
  "confidence": 0,
  "candidates": [
    {
      "subclass": "string",
      "confidence": 0
    }
  ],
  "reason": "string"
}

Component:

Alias ID:
${item.aliasId}

Part Number:
${item.partNumber}

Manufacturer:
${item.manufacturer}

Component Type:
${item.componentType}

Properties:
${JSON.stringify(item.properties, null, 2)}

Candidate subclasses:
${JSON.stringify(candidateSubclasses, null, 2)}

Rules:

1. Only use subclasses from the supplied candidate list.
2. Do not create new subclass names.
3. Rank the candidates according to relevance to the component information.
4. The confidence values are AI relevance scores, not calibrated probabilities.
5. Return all supplied candidates when possible.
6. The highest-confidence candidate must be predictedSubclass.
7. Return JSON only.
`;

  const content = await callGemini(
    prompt,
    "You are an engineering component classification assistant. Return valid JSON only."
  );

  const jsonText =
    extractJsonText(content);

  try {
    const parsed = JSON.parse(jsonText);

    return {
      predictedSubclass:
        parsed.predictedSubclass || "",

      confidence:
        Number(parsed.confidence) || 0,

      candidates:
        Array.isArray(parsed.candidates)
          ? parsed.candidates.map((candidate) => ({
            subclass:
              String(candidate.subclass || "").trim(),

            confidence:
              Number(candidate.confidence) || 0
          }))
          : [],

      reason:
        parsed.reason ||
        "Subclass relevance was determined from the supplied component information."
    };
  } catch (error) {
    console.error(
      "Failed to parse subclass JSON:",
      jsonText
    );

    throw new Error(
      "NVIDIA subclass response was not valid JSON.",
      {
        cause: error
      }
    );
  }
}