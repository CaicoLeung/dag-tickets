import type { Ticket } from "./types.ts";
import { parseBlockedByRefs, parseCoordinateRefs } from "./parse.ts";
import { resolveKind, type RoutingConfig, DEFAULT_ROUTING } from "./config.ts";
import { resolveTitleEdges } from "./graph.ts";
import { repoInfo } from "./gitgh.ts";
import { mustRun } from "./shell.ts";

interface RawIssue {
  number: number;
  title: string;
  body: string | null;
  url: string;
  state: string;
  labels: Array<{ name: string }>;
}

interface Mapped {
  ticket: Ticket;
  titleRefs: string[];
}

function mapTicket(raw: RawIssue, cfg: RoutingConfig): Mapped {
  const labels = raw.labels.map((l) => l.name);
  const refs = parseBlockedByRefs(raw.body);
  return {
    ticket: {
      number: raw.number,
      title: raw.title,
      url: raw.url,
      body: raw.body ?? "",
      labels,
      state: raw.state === "closed" ? "closed" : "open",
      blockedBy: refs.numbers,
      coordinateWith: parseCoordinateRefs(raw.body, labels),
      kind: resolveKind(labels, cfg),
    },
    titleRefs: refs.titleRefs,
  };
}

/** Resolve title-refs to numbers within the batch, then return bare tickets. */
function finalize(mapped: Mapped[]): Ticket[] {
  const refs = new Map<number, string[]>(mapped.map((m) => [m.ticket.number, m.titleRefs]));
  return resolveTitleEdges(
    mapped.map((m) => m.ticket),
    refs,
  );
}

/** Fetch full issue detail for an explicit list of numbers. */
export async function fetchIssues(
  numbers: number[],
  cwd?: string,
  cfg: RoutingConfig = DEFAULT_ROUTING,
): Promise<Ticket[]> {
  const mapped: Mapped[] = [];
  for (const n of numbers) {
    const r = await mustRun(
      ["gh", "issue", "view", String(n), "--json", "number,title,body,url,state,labels"],
      { cwd },
    );
    mapped.push(mapTicket(JSON.parse(r.stdout) as RawIssue, cfg));
  }
  return finalize(mapped);
}

/** All open issues carrying a given label (e.g. `ready-for-agent`). */
export async function searchByLabel(
  label: string,
  cwd?: string,
  cfg: RoutingConfig = DEFAULT_ROUTING,
): Promise<Ticket[]> {
  const r = await mustRun(
    [
      "gh",
      "issue",
      "list",
      "--label",
      label,
      "--state",
      "open",
      "--json",
      "number,title,body,url,state,labels",
      "--limit",
      "200",
    ],
    { cwd },
  );
  const raw = JSON.parse(r.stdout) as RawIssue[];
  return finalize(raw.map((x) => mapTicket(x, cfg)));
}

/**
 * Sub-issues of a parent issue, via the GraphQL API (GitHub's native
 * parent/subIssues relationship). Falls back to parsing the parent body for
 * `#N` references when the tracker has none.
 */
export async function listSubIssues(
  parent: number,
  cwd?: string,
  cfg: RoutingConfig = DEFAULT_ROUTING,
): Promise<Ticket[]> {
  const { owner, repo } = await repoInfo(cwd);
  // Values are bound as typed GraphQL variables below, never interpolated into the query.
  const query = `query($owner: String!, $repo: String!, $parent: Int!) {
    repository(owner: $owner, name: $repo) {
      issue(number: $parent) {
        subIssues(first: 100) {
          nodes {
            number title body url state
            labels(first: 50) { nodes { name } }
          }
        }
      }
    }
  }`;
  const r = await mustRun(
    [
      "gh", "api", "graphql",
      "-f", `query=${query}`,
      "-F", `owner=${owner}`,
      "-F", `repo=${repo}`,
      "-F", `parent=${parent}`,
    ],
    { cwd },
  );
  const j = JSON.parse(r.stdout);
  const nodes: RawIssue[] = j?.data?.repository?.issue?.subIssues?.nodes ?? [];

  if (nodes.length > 0) return finalize(nodes.map((x) => mapTicket(x, cfg)));

  // No native sub-issues — parse #N references out of the parent body.
  const parentView = await mustRun(
    ["gh", "issue", "view", String(parent), "--json", "body"],
    { cwd },
  );
  const body = (JSON.parse(parentView.stdout).body ?? "") as string;
  const refs = [...body.matchAll(/#(\d+)/g)].map((m) => parseInt(m[1]!, 10));
  const uniq = [...new Set(refs)].filter((n) => n !== parent);
  return fetchIssues(uniq, cwd, cfg);
}
