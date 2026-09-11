// Ontology api names the REST adapter uses (plan U8). The defaults follow the
// ERD in the plan; the real names are pasted after U3 through the optional
// FOUNDRY_ONTOLOGY_NAMES JSON env var, which is deep-merged over these
// defaults so a single renamed property needs a one-key override, not a full
// copy. Lives in lib/ (not foundry/) so config.ts can import it at runtime
// without crossing the disclosure boundary in scripts/check-no-disclosure.sh.

export interface OntologyNames {
  user: {
    objectType: string;
    properties: { userId: string; fullName: string; phoneE164: string; pinHash: string; siteId: string };
    /** User -> Site, and the reverse (User -> its reported Issues). */
    links: { site: string; reportedIssues: string };
  };
  issue: {
    objectType: string;
    properties: {
      issueId: string;
      title: string;
      description: string;
      status: string;
      priority: string;
      resolution: string;
      reportedByUserId: string;
      assignedTeamId: string;
      sourceConversationId: string;
      createdAt: string;
      updatedAt: string;
    };
    /** Issue -> User and Issue -> Team. */
    links: { reportedBy: string; assignedTeam: string };
  };
  site: {
    objectType: string;
    properties: { siteId: string; name: string };
    /** Site -> Users (reverse of user.links.site). */
    links: { users: string };
  };
  team: {
    objectType: string;
    properties: { teamId: string; name: string };
    /** Team -> Issues (reverse of issue.links.assignedTeam). */
    links: { assignedIssues: string };
  };
  action: {
    createIssue: string;
    parameters: {
      issueId: string;
      title: string;
      description: string;
      priority: string;
      reportedBy: string;
      assignedTeam: string;
      sourceConversationId: string;
    };
  };
  /** Stored values of the status property, keyed by the contract's IssueStatus. */
  statusValues: { open: string; in_progress: string; resolved: string };
  /** Primary key of the team every new issue lands on (plan KTD8); seeded in teams.csv. */
  triageTeamId: string;
}

export const DEFAULT_ONTOLOGY_NAMES: OntologyNames = {
  user: {
    objectType: "HelpdeskUser",
    properties: { userId: "userId", fullName: "fullName", phoneE164: "phoneE164", pinHash: "pinHash", siteId: "siteId" },
    links: { site: "site", reportedIssues: "reportedIssues" },
  },
  issue: {
    objectType: "HelpdeskIssue",
    properties: {
      issueId: "issueId",
      title: "title",
      description: "description",
      status: "status",
      priority: "priority",
      resolution: "resolution",
      reportedByUserId: "reportedByUserId",
      assignedTeamId: "assignedTeamId",
      sourceConversationId: "sourceConversationId",
      createdAt: "createdAt",
      updatedAt: "updatedAt",
    },
    links: { reportedBy: "reportedBy", assignedTeam: "assignedTeam" },
  },
  site: { objectType: "Site", properties: { siteId: "siteId", name: "name" }, links: { users: "users" } },
  team: { objectType: "Team", properties: { teamId: "teamId", name: "name" }, links: { assignedIssues: "assignedIssues" } },
  action: {
    createIssue: "createHelpdeskIssue",
    parameters: {
      issueId: "issueId",
      title: "title",
      description: "description",
      priority: "priority",
      reportedBy: "reportedBy",
      assignedTeam: "assignedTeam",
      sourceConversationId: "sourceConversationId",
    },
  },
  statusValues: { open: "open", in_progress: "in_progress", resolved: "resolved" },
  triageTeamId: "triage",
};

/** A recursive partial with string leaves: what FOUNDRY_ONTOLOGY_NAMES may carry. */
export type OntologyNamesOverride = {
  [K in keyof OntologyNames]?: OntologyNames[K] extends string ? string : { [P in keyof OntologyNames[K]]?: OntologyNames[K][P] extends string ? string : Partial<OntologyNames[K][P]> };
};

export class OntologyNamesError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OntologyNamesError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function mergeNode(base: unknown, override: unknown, path: string): unknown {
  if (typeof base === "string") {
    if (typeof override !== "string" || override.trim().length === 0) {
      throw new OntologyNamesError(`${path} must be a non-empty string`);
    }
    return override;
  }
  if (!isRecord(base)) throw new OntologyNamesError(`${path} is not overridable`);
  if (!isRecord(override)) throw new OntologyNamesError(`${path} must be an object`);
  const out: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(override)) {
    if (!(key in base)) throw new OntologyNamesError(`unknown key ${path ? `${path}.${key}` : key}`);
    out[key] = mergeNode(base[key], value, path ? `${path}.${key}` : key);
  }
  return out;
}

/**
 * Deep-merges `override` over `base`. Unknown keys and non-string leaves are
 * rejected so a typo in the pasted override fails at boot, not at the first
 * tool call. Throws OntologyNamesError; the message names the offending path.
 */
export function mergeOntologyNames(base: OntologyNames, override: unknown): OntologyNames {
  if (!isRecord(override)) throw new OntologyNamesError("override must be a JSON object");
  return mergeNode(base, override, "") as OntologyNames;
}
