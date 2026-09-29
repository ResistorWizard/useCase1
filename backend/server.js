import "dotenv/config";

import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import cors from "cors";
import XLSX from "xlsx";

import {
  getItemByAliasId,
  getSubclassCandidates,
  getAvailableDataSources,
  getDataSourceConfig
} from "./data/excelAdapter.js";

import {
  verifyItem,
  identifySubclass
} from "./services/geminiService.js";

import {
  compareItemData
} from "./services/verificationService.js";


function normalizeComparableValue(value) {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function calculateValueSimilarity(valueA, valueB) {
  const a = normalizeComparableValue(valueA);
  const b = normalizeComparableValue(valueB);

  if (!a && !b) {
    return 1;
  }

  if (!a || !b) {
    return 0;
  }

  if (a === b) {
    return 1;
  }

  const aTokens = a.split(" ").filter(Boolean);
  const bTokens = b.split(" ").filter(Boolean);

  if (!aTokens.length || !bTokens.length) {
    return 0;
  }

  const intersection = aTokens.filter((token) =>
    bTokens.includes(token)
  ).length;

  const union = new Set([...aTokens, ...bTokens]).size;

  if (union === 0) {
    return 1;
  }

  return Math.min(1, intersection / union);
}

function buildComparisonScore(properties, item) {
  const propertyScores = properties.map((property) => {
    const score = Number(property.confidence) || 0;

    return {
      name: property.name,
      confidence: score
    };
  });

  const matchedCount = properties.filter(
    (property) => property.status === "MATCH"
  ).length;
  const mismatchCount = properties.filter(
    (property) => property.status === "MISMATCH"
  ).length;
  const unverifiedCount = properties.filter(
    (property) => property.status === "NOT_VERIFIED"
  ).length;
  const overallConfidence = propertyScores.length > 0
    ? Math.round((matchedCount / propertyScores.length) * 100)
    : 0;
  const status = mismatchCount > 0
    ? "Differences found"
    : unverifiedCount > 0 || !item || propertyScores.length === 0
      ? "Needs review"
      : "All properties match";

  return {
    overallConfidence,
    status,
    propertyScores
  };
}

// =========================================================
// FALLBACK
// =========================================================

export function buildFallbackVerification(item, outsourceItem = null) {
  const localSourceProperties =
    outsourceItem?.properties || {};

  const properties =
    Object.entries(
      item.properties || {}
    ).map(([name, value]) => {
      const normalizedValue =
        value === null ||
        value === undefined
          ? ""
          : String(value).trim();

      const outsourceValue =
        localSourceProperties[name];

      const normalizedOutsourceValue =
        outsourceValue === null ||
        outsourceValue === undefined
          ? ""
          : String(outsourceValue).trim();

      const similarity =
        calculateValueSimilarity(
          normalizedValue,
          normalizedOutsourceValue
        );

      const confidence =
        Math.round(similarity * 100);

      const isMatch =
        normalizedOutsourceValue !== "" &&
        confidence >= 80;

      const isMismatch =
        normalizedOutsourceValue !== "" &&
        !isMatch;

      return {
        name,

        existingValue:
          normalizedValue,

        verifiedValue:
          normalizedOutsourceValue,

        status:
          isMatch
            ? "MATCH"
            : isMismatch
              ? "MISMATCH"
              : "NOT_VERIFIED",

        confidence,

        source:
          isMatch || isMismatch
            ? "Local cross-source comparison"
            : "Local fallback verification",

        explanation:
          isMatch
            ? `This value matched the outsource record with ${confidence}% confidence.`
            : isMismatch
              ? `This value differs from the outsource record and is below the acceptable match confidence.`
              : "The remote verification service was unavailable, so this Excel value was not independently verified."
      };
    });

  return {
    componentType:
      item.componentType || "",

    verifiedProperties:
      properties,

    comparisonScore:
      buildComparisonScore(
        properties,
        item
      )
  };
}


// =========================================================
// EXPRESS APP
// =========================================================

const app = express();

app.use(cors());

app.use(express.json());

app.get("/api/source-file", (req, res) => {
  const sourceId = req.query.source || "teamcenter1";
  const config = getDataSourceConfig(sourceId);
  const sourceFilePath = path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    "data",
    config.filePath
  );

  res.download(sourceFilePath, config.filePath);
});

app.post("/api/update-item", (req, res) => {
  try {
    const {
      aliasId,
      sourceId = "teamcenter1",
      partNumber,
      manufacturer,
      componentType,
      properties = {}
    } = req.body || {};

    if (!aliasId || String(aliasId).trim() === "") {
      return res.status(400).json({
        error: "Alias ID is required for update."
      });
    }

    const normalizedAliasId = String(aliasId).trim();
    const config = getDataSourceConfig(sourceId);
    const workbookPath = path.join(
      path.dirname(fileURLToPath(import.meta.url)),
      "data",
      config.filePath
    );

    const workbook = XLSX.readFile(workbookPath);
    const firstSheet = workbook.Sheets[workbook.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json(firstSheet, { defval: "" });

    const rowIndex = rows.findIndex(
      (row) => String(row.AliasID || "").trim() === normalizedAliasId
    );

    const normalizedProperties = Object.fromEntries(
      Object.entries(properties || {}).map(([key, value]) => [
        String(key).trim(),
        value === undefined || value === null ? "" : String(value).trim()
      ])
    );

    const row = rowIndex >= 0 ? rows[rowIndex] : {};
    row.AliasID = normalizedAliasId;
    row.PartNumber = partNumber === undefined
      ? row.PartNumber || normalizedAliasId
      : String(partNumber).trim();
    row.Manufacturer = manufacturer === undefined
      ? row.Manufacturer || ""
      : String(manufacturer).trim();
    row.ComponentType = componentType === undefined
      ? row.ComponentType || ""
      : String(componentType).trim();
    row.Properties = JSON.stringify(normalizedProperties, null, 2);

    const parameterColumns = [
      "Parameter1",
      "Parameter2",
      "Parameter3",
      "Parameter4"
    ];

    parameterColumns.forEach((column, index) => {
      const entry = Object.entries(normalizedProperties)[index];
      row[column] = entry ? `${entry[0]}: ${entry[1]}` : "";
    });

    if (rowIndex >= 0) {
      rows[rowIndex] = row;
    } else {
      rows.push(row);
    }

    const updatedSheet = XLSX.utils.json_to_sheet(rows);
    workbook.Sheets[workbook.SheetNames[0]] = updatedSheet;
    XLSX.writeFile(workbook, workbookPath);

    return res.status(200).json({
      success: true,
      sourceId: config.id,
      sourceLabel: config.label,
      mode: rowIndex >= 0 ? "updated" : "created",
      aliasId: normalizedAliasId,
      message:
        rowIndex >= 0
          ? `Updated Teamcenter record for ${normalizedAliasId}.`
          : `Created a new Teamcenter record for ${normalizedAliasId}.`
    });
  } catch (error) {
    console.error("Update item failed:", error);
    return res.status(500).json({
      error: "Failed to update Teamcenter record.",
      details: error.message
    });
  }
});


// =========================================================
// HEALTH CHECK
// =========================================================

app.get("/", (req, res) => {
  res.json({
    message:
      "Item Verification Backend is running",

    status:
      "OK"
  });
});


// =========================================================
// ITEM VERIFICATION
// =========================================================

app.post(
  "/api/verify-item",
  async (req, res) => {
    try {
      const { aliasId, sourceId = "teamcenter1" } =
        req.body;

      console.log(
        "\n================================="
      );

      console.log(
        "ITEM VERIFICATION REQUEST"
      );

      console.log(
        "================================="
      );

      console.log(
        "Alias ID:",
        aliasId
      );


      // -------------------------------------------------
      // VALIDATE
      // -------------------------------------------------

      if (
        !aliasId ||
        aliasId.trim() === ""
      ) {
        return res.status(400).json({
          error:
            "Alias ID is required"
        });
      }


      const normalizedAliasId =
        aliasId.trim();

      const selectedSource =
        getDataSourceConfig(sourceId);


      // -------------------------------------------------
      // GET ITEM FROM EXCEL
      // -------------------------------------------------

      const item =
        getItemByAliasId(
          normalizedAliasId,
          selectedSource.id
        );


      if (!item) {
        console.log(
          "Item not found."
        );

        return res.status(404).json({
          error:
            `No item found for Alias ID: ${normalizedAliasId}`
        });
      }


      console.log(
        "\nExisting item:"
      );

      console.log(
        JSON.stringify(
          item,
          null,
          2
        )
      );

      const outsourceItem =
        getItemByAliasId(
          normalizedAliasId,
          "outsource"
        );


      // -------------------------------------------------
      // AI ITEM VERIFICATION
      // -------------------------------------------------

      let verifiedData;

      try {
        console.log(
          "\nSending item to verification API..."
        );

        verifiedData =
          await verifyItem(
            item
          );

        console.log(
          "\nVerification completed."
        );
      } catch (error) {
        console.log(
          "\nVerification service unavailable."
        );

        console.log(
          "Reason:",
          error.message
        );

        verifiedData = {
          componentType: item.componentType || "",
          verifiedProperties: [],
          aiVerificationError: {
            available: false,
            source: "NVIDIA API",
            error: error.message,
            fallbackUsed: false,
            message:
              "AI verification is currently unavailable. Please review the item manually or retry later."
          }
        };

        console.log(
          "\nAI verification unavailable; no fallback verification was used."
        );
      }


      // -------------------------------------------------
      // SUBCLASS CANDIDATES
      // -------------------------------------------------

      let subclassCandidates = [];

      try {
        subclassCandidates =
          getSubclassCandidates(
            item,
            selectedSource.id
          );

        console.log(
          "\nSubclass candidates:"
        );

        console.log(
          subclassCandidates
        );
      } catch (error) {
        console.warn(
          "Unable to read subclass candidates:",
          error.message
        );
      }


      // -------------------------------------------------
      // AI SUBCLASS IDENTIFICATION
      // -------------------------------------------------

      let subclassIdentification = {
        predictedSubclass: item.subclass || "",
        confidence: item.subclass ? 100 : 0,
        source: item.subclass ? "Source workbook" : "AI",
        candidates: subclassCandidates.map((subclass) => ({
          subclass,
          confidence: subclass === item.subclass ? 100 : 0
        })),
        reason: item.subclass
          ? "Subclass was read from the selected source workbook."
          : "Subclass identification was not available."
      };


      if (subclassCandidates.length > 0 && !item.subclass) {
        try {
          console.log(
            "\nSending item for subclass identification..."
          );

          subclassIdentification =
            await identifySubclass(
              item,
              subclassCandidates
            );
          subclassIdentification.source = "AI";

          console.log(
            "\nSubclass identification completed."
          );

          console.log(
            JSON.stringify(
              subclassIdentification,
              null,
              2
            )
          );
        } catch (error) {
          console.warn(
            "\nSubclass identification unavailable."
          );

          console.warn(
            "Reason:",
            error.message
          );
          subclassIdentification.candidates = subclassCandidates.map(
            (subclass) => ({ subclass, confidence: 0 })
          );
          subclassIdentification.source = "Workbook candidates";
        }
      } else {
        console.log(
          "\nNo subclass candidates found in Excel."
        );
      }


      // -------------------------------------------------
      // COMPARE
      // -------------------------------------------------

      console.log(
        "\nComparing item data..."
      );

      const comparison =
        compareItemData(
          item,
          verifiedData,
          subclassIdentification,
          {
            sourceId: selectedSource.id,
            sourceLabel: selectedSource.label,
            sourceLink: `http://localhost:5000/api/source-file?source=${selectedSource.id}`,
            outsourceItem,
            outsourceSourceLabel: "Outsource Excel"
          }
        );


      // -------------------------------------------------
      // FINAL RESPONSE
      // -------------------------------------------------

      console.log(
        "\nFinal comparison:"
      );

      console.log(
        JSON.stringify(
          comparison,
          null,
          2
        )
      );


      const aiVerification =
        verifiedData?.aiVerificationError || {
          available: true,
          source: "NVIDIA API",
          error: "",
          fallbackUsed: false,
          message: "AI verification completed successfully."
        };

      return res.status(200).json({
        ...comparison,
        aiVerification,
        availableSources: getAvailableDataSources(),
        sourceContext: {
          id: selectedSource.id,
          label: selectedSource.label,
          link: `http://localhost:5000/api/source-file?source=${selectedSource.id}`
        },
        canUpdate: aiVerification.available,
        updateStatus: aiVerification.available
          ? comparison?.comparisonScore?.overallConfidence >= 80
            ? "Ready for Teamcenter update check"
            : "New or mismatched data requires update"
          : "AI verification unavailable; update requires manual review"
      });

    } catch (error) {
      console.error(
        "\n================================="
      );

      console.error(
        "BACKEND ERROR"
      );

      console.error(
        "================================="
      );

      console.error(
        error
      );

      return res.status(500).json({
        error:
          "Item verification failed",

        details:
          error.message
      });
    }
  }
);


// =========================================================
// START SERVER
// =========================================================

const PORT = 5000;

app.listen(
  PORT,
  () => {
    console.log("");

    console.log(
      "================================="
    );

    console.log(
      "ITEM VERIFICATION BACKEND"
    );

    console.log(
      "================================="
    );

    console.log(
      `Server running on http://localhost:${PORT}`
    );

    console.log(
      "================================="
    );

    console.log("");
  }
);