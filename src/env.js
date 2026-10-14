/** Setting `NAME` from DECISIONS_NAME, or the legacy JEV_NAME (the project was called jev-offload-mcp). */
export const env = (name) => process.env[`DECISIONS_${name}`] ?? process.env[`JEV_${name}`];
