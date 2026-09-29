import test from "node:test";
import assert from "node:assert/strict";

import { compareItemData } from "../services/verificationService.js";
import { buildFallbackVerification } from "../server.js";

test("comparison keeps Teamcenter and outsource properties when AI omits results", () => {
  const existingItem = {
    aliasId: "ITEM-1",
    properties: {
      Material: "SS304",
      Pressure: "120 Psi"
    }
  };
  const outsourceItem = {
    properties: {
      Material: "SS316",
      Pressure: "125 Psi"
    }
  };

  const comparison = compareItemData(
    existingItem,
    { verifiedProperties: [] },
    null,
    { outsourceItem }
  );

  assert.equal(comparison.properties.length, 2);
  assert.equal(comparison.properties[0].status, "NOT_VERIFIED");
  assert.equal(comparison.outsourceComparison.hasData, true);
  assert.deepEqual(comparison.outsourceComparison.properties, [
    { name: "Material", value: "SS316" },
    { name: "Pressure", value: "125 Psi" }
  ]);
});

test("comparison preserves AI results while filling omitted Teamcenter properties", () => {
  const comparison = compareItemData(
    {
      aliasId: "ITEM-2",
      properties: { Material: "SS304", Pressure: "120 Psi" }
    },
    {
      verifiedProperties: [
        {
          name: "Material",
          verifiedValue: "SS304",
          status: "MATCH",
          source: "Catalog",
          explanation: "Values match."
        }
      ]
    }
  );

  assert.equal(comparison.properties[0].status, "MATCH");
  assert.equal(comparison.properties[1].name, "Pressure");
  assert.equal(comparison.properties[1].status, "NOT_VERIFIED");
});

test("comparison reports differing values as mismatches even if AI says match", () => {
  const comparison = compareItemData(
    {
      aliasId: "ITEM-3",
      properties: { "Wire Size": "0-10 AWG" }
    },
    {
      verifiedProperties: [
        {
          name: "Wire Size",
          verifiedValue: "0-20 AWG",
          status: "MATCH",
          confidence: 99
        }
      ]
    }
  );

  assert.equal(comparison.properties[0].status, "MISMATCH");
  assert.equal(comparison.comparisonScore.status, "Differences found");
  assert.equal(comparison.comparisonScore.overallConfidence, 0);
});

test("single AWG value does not verify a range-valued wire size", () => {
  const comparison = compareItemData(
    {
      aliasId: "ITEM-4",
      properties: { "Wire Size": "10-12 AWG" }
    },
    {
      verifiedProperties: [
        {
          name: "Wire Size",
          verifiedValue: "12 AWG",
          status: "MISMATCH",
          explanation: "AI returned a single gauge."
        }
      ]
    }
  );

  assert.equal(comparison.properties[0].status, "NOT_VERIFIED");
  assert.match(comparison.properties[0].explanation, /complete AWG range/i);
});

test("fallback verification marks matching cross-source values as verified", () => {
  const item = {
    componentType: "Wire Contact",
    properties: {
      "Contact Type": "Socket",
      "Wire Size": "0-10 AWG"
    }
  };

  const outsourceItem = {
    properties: {
      "Contact Type": "Socket",
      "Wire Size": "0-10 AWG"
    }
  };

  const fallback = buildFallbackVerification(item, outsourceItem);

  assert.equal(fallback.verifiedProperties.length, 2);
  assert.equal(fallback.verifiedProperties[0].status, "MATCH");
  assert.equal(fallback.verifiedProperties[1].status, "MATCH");
});
