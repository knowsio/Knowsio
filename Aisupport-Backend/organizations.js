export const ORGANIZATIONS = {
  MMM:{label : "Menader medisch centrum"},
  RZH:{label : "Rijnstate ziekenhuis"}
}

// (Optional) expose safe, non-secret info to the UI
export function listOrganizations() {
  return Object.entries(ORGANIZATIONS).map(([key, v]) => ({
    key, label: v.label
  }));
}