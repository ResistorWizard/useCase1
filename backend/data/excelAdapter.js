import XLSX from "xlsx";
import { fileURLToPath } from "node:url";
import path from "node:path";

const currentFile = fileURLToPath(import.meta.url);
const currentDirectory = path.dirname(currentFile);

export const dataSourceConfigs = {
  teamcenter1: {
    id: "teamcenter1",
    label: "Teamcenter 1",
    shortLabel: "TC1",
    type: "excel",
    filePath: "teamcenter1.xlsx",
    description: "Primary Teamcenter data source",
    sourceLink: "teamcenter1.xlsx"
  },
  teamcenter2: {
    id: "teamcenter2",
    label: "Teamcenter 2",
    shortLabel: "TC2",
    type: "excel",
    filePath: "teamcenter2.xlsx",
    description: "Secondary Teamcenter data source",
    sourceLink: "teamcenter2.xlsx"
  },
  outsource: {
    id: "outsource",
    label: "Outsource Excel",
    shortLabel: "Outsource",
    type: "excel",
    filePath: "outsource.xlsx",
    description: "Editable outsourced copy of the Teamcenter 1 workbook",
    sourceLink: "outsource.xlsx"
  }
};

export function getAvailableDataSources() {
  return Object.values(dataSourceConfigs);
}

export function getDataSourceConfig(sourceId = "teamcenter1") {
  return dataSourceConfigs[sourceId] || dataSourceConfigs.teamcenter1;
}

function getWorkbookPath(sourceId = "teamcenter1") {
  const config = getDataSourceConfig(sourceId);

  return path.join(
    currentDirectory,
    config.filePath
  );
}

function clean(value) {
  if (value === null || value === undefined) {
    return "";
  }

  return String(value).trim();
}

function findColumn(row, possibleNames) {
  const rowKeys = Object.keys(row);

  const matchedKey = rowKeys.find((key) =>
    possibleNames.some(
      (name) =>
        String(key).trim().toLowerCase() ===
        String(name).trim().toLowerCase()
    )
  );

  return matchedKey || null;
}

function extractProperties(item) {
  const propertyColumns = [
    "Parameter1",
    "Parameter2",
    "Parameter3",
    "Parameter4"
  ];

  const visibleProperties = Object.fromEntries(
    propertyColumns
      .map((column) => clean(item[column]))
      .filter(Boolean)
      .map((property) => {
        const separatorIndex = property.indexOf(":");

        if (separatorIndex === -1) {
          return [property, ""];
        }

        return [
          property.slice(0, separatorIndex).trim(),
          property.slice(separatorIndex + 1).trim()
        ];
      })
  );

  if (Object.keys(visibleProperties).length > 0) {
    return visibleProperties;
  }

  const propertiesText = clean(item.Properties);

  if (!propertiesText) {
    return {};
  }

  try {
    return JSON.parse(propertiesText);
  } catch {
    console.warn(
      "Properties column could not be parsed as JSON. Using empty properties."
    );

    return {};
  }
}

export function getItemByAliasId(aliasId, sourceId = "teamcenter1") {
  const workbookPath = getWorkbookPath(sourceId);
  const workbook = XLSX.readFile(workbookPath);

  if (!workbook.SheetNames.length) {
    throw new Error("Excel workbook does not contain any sheets.");
  }

  const itemsSheet = workbook.Sheets[workbook.SheetNames[0]];

  const itemRows = XLSX.utils.sheet_to_json(itemsSheet, {
    defval: ""
  });

  const normalizedAliasId = aliasId
    .trim()
    .split("@")[0]
    .trim();

  const item = itemRows.find(
    (row) => String(row.AliasID).trim() === normalizedAliasId
  );

  if (!item) {
    return null;
  }

  /*
   * We do not assume that the Excel has a subclass column.
   * If one exists, we capture it.
   */
  const subclassColumn = findColumn(item, [
    "Subclass",
    "SubClass",
    "Sub Class",
    "SubItem",
    "Sub Item",
    "ComponentSubclass",
    "Component Subclass",
    "Component Sub-Class"
  ]);

  const subclass = subclassColumn
    ? clean(item[subclassColumn])
    : "";

  return {
    aliasId: clean(item.AliasID),
    partNumber: clean(item.PartNumber),
    manufacturer: clean(item.Manufacturer),
    componentType: clean(item.ComponentType),
    subclass,
    properties: extractProperties(item)
  };
}

export function getSubclassCandidates(item, sourceId = "teamcenter1") {
  const workbook = XLSX.readFile(getWorkbookPath(sourceId));

  if (!workbook.SheetNames.length) {
    return [];
  }

  const sheet = workbook.Sheets[workbook.SheetNames[0]];

  const rows = XLSX.utils.sheet_to_json(sheet, {
    defval: ""
  });

  if (!rows.length) {
    return [];
  }

  const subclassColumn = findColumn(rows[0], [
    "Subclass",
    "SubClass",
    "Sub Class",
    "SubItem",
    "Sub Item",
    "ComponentSubclass",
    "Component Subclass",
    "Component Sub-Class"
  ]);

  if (!subclassColumn) {
    return [];
  }

  const componentTypeColumn = findColumn(rows[0], [
    "ComponentType",
    "Component Type"
  ]);

  const candidates = rows
    .filter((row) => {
      if (!componentTypeColumn) {
        return true;
      }

      return (
        clean(row[componentTypeColumn]).toLowerCase() ===
        clean(item.componentType).toLowerCase()
      );
    })
    .map((row) => clean(row[subclassColumn]))
    .filter(Boolean);

  return [...new Set(candidates)];
}