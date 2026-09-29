function normalizeComparedValue(value) {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function isAwgRange(value) {
  return /\b\d{1,2}\s*(?:-|–|—|to)\s*\d{1,2}\s*AWG\b/i.test(
    String(value ?? "")
  );
}

export function compareItemData(
  existingItem,
  verifiedData,
  subclassIdentification = null,
  sourceContext = {}
) {
  const verifiedProperties = Array.isArray(
    verifiedData.verifiedProperties
  )
    ? verifiedData.verifiedProperties
    : [];

  const aiVerificationError =
    verifiedData?.aiVerificationError || null;

  const verifiedByName = new Map(
    verifiedProperties
      .filter((property) => property?.name)
      .map((property) => [
        String(property.name).trim().toLowerCase(),
        property
      ])
  );
  const results = Object.entries(
    existingItem.properties || {}
  ).map(([name, existingValue]) => {
    const verified = verifiedByName.get(
      name.trim().toLowerCase()
    );

    const confidence = Number(verified?.confidence) || 0;
    const normalizedExisting = normalizeComparedValue(existingValue);
    const normalizedVerified = normalizeComparedValue(verified?.verifiedValue);
    const incompleteAwgRange =
      isAwgRange(existingValue) && !isAwgRange(verified?.verifiedValue);
    const status = !normalizedVerified ||
      verified?.status === "NOT_VERIFIED" ||
      incompleteAwgRange
      ? "NOT_VERIFIED"
      : normalizedExisting === normalizedVerified
        ? "MATCH"
        : "MISMATCH";

    return {
      name,
      existingValue,
      verifiedValue: verified?.verifiedValue || "",
      status: aiVerificationError ? "NOT_VERIFIED" : status,
      confidence,
      source:
        aiVerificationError
          ? "AI unavailable"
          : verified?.source ||
            "AI verification did not return this property",
      explanation:
        aiVerificationError
          ? `AI verification is unavailable: ${aiVerificationError.error || "No details were returned by the verification service."}`
          : incompleteAwgRange
            ? `AI returned "${String(verified?.verifiedValue || "").trim()}" instead of confirming the complete AWG range "${existingValue}". The range is not verified.`
          : verified?.explanation ||
            "No AI verification value was returned for this property."
    };
  });

  const matchedCount = results.filter(
    (property) => property.status === "MATCH"
  ).length;

  const matches = results.filter(
    (property) => property.status === "MATCH"
  );

  const mismatches = results.filter(
    (property) => property.status === "MISMATCH"
  );

  const notVerified = results.filter(
    (property) => property.status === "NOT_VERIFIED"
  );

  const matchPercentage =
    results.length > 0
      ? Math.round(
          (matchedCount / results.length) * 100
        )
      : 0;

  const comparisonStatus = mismatches.length > 0
    ? "Differences found"
    : notVerified.length > 0
      ? "Needs review"
      : results.length > 0
        ? "All properties match"
        : "No properties to compare";

  const comparisonSources = {
    selectedSource: sourceContext.sourceLabel || "Teamcenter",
    sourceLink: sourceContext.sourceLink || "",
    outsourceSource: sourceContext.outsourceSourceLabel || "Outsource Excel",
    outsourceItem: sourceContext.outsourceItem || null
  };

  const outsourcedProperties = Object.entries(
    sourceContext.outsourceItem?.properties || {}
  ).map(([name, value]) => ({
    name,
    value
  }));

  return {
    aliasId: existingItem.aliasId,

    partNumber:
      existingItem.partNumber,

    manufacturer:
      existingItem.manufacturer,

    componentType:
      verifiedData.componentType ||
      existingItem.componentType,

    comparisonScore: {
      overallConfidence: matchPercentage,
      status: comparisonStatus,
      propertyScores: results.map((property) => ({
        name: property.name,
        confidence: Number(property.confidence) || 0
      }))
    },

    summary: {
      totalProperties: results.length,
      matches: matches.length,
      mismatches: mismatches.length,
      notVerified: notVerified.length
    },

    subclassIdentification:
      subclassIdentification || {
        predictedSubclass: "",
        confidence: 0,
        candidates: [],
        reason:
          "Subclass identification was not available."
      },

    sourceContext: comparisonSources,

    properties: results,

    outsourceComparison: {
      properties: outsourcedProperties,
      hasData: outsourcedProperties.length > 0,
      item: sourceContext.outsourceItem || null
    },

    corrections: mismatches.map(
      (property) => ({
        property: property.name,
        oldValue:
          property.existingValue,
        newValue:
          property.verifiedValue,
        source:
          property.source,
        explanation:
          property.explanation
      })
    )
  };
}