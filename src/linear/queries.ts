// Linear GraphQL read queries required by the orchestrator (SPEC §11.1–11.2).
// Query construction is kept isolated so the exact fields/types can be tested (SPEC §11.2).

export const CANDIDATE_ISSUES_QUERY = `
query JazzbandLinearPoll($projectSlug: String!, $stateNames: [String!]!, $first: Int!, $relationFirst: Int!, $after: String) {
  issues(filter: {project: {slugId: {eq: $projectSlug}}, state: {name: {in: $stateNames}}}, first: $first, after: $after) {
    nodes {
      id
      identifier
      title
      description
      priority
      state { name }
      branchName
      url
      attachments { nodes { url } }
      labels { nodes { name } }
      inverseRelations(first: $relationFirst) {
        nodes {
          type
          issue { id identifier state { name } }
        }
      }
      createdAt
      updatedAt
    }
    pageInfo { hasNextPage endCursor }
  }
}
`.trim();

export const ISSUES_BY_ID_QUERY = `
query JazzbandLinearIssuesById($ids: [ID!]!, $first: Int!, $relationFirst: Int!) {
  issues(filter: {id: {in: $ids}}, first: $first) {
    nodes {
      id
      identifier
      title
      description
      priority
      state { name }
      branchName
      url
      attachments { nodes { url } }
      labels { nodes { name } }
      inverseRelations(first: $relationFirst) {
        nodes {
          type
          issue { id identifier state { name } }
        }
      }
      createdAt
      updatedAt
    }
  }
}
`.trim();
