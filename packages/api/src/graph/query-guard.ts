// D131, D144: our code refuses any graph query that names a database, before it is sent.
// The 28 read-only accounts (D73) and grc_writer are shared by every org, so Neo4j's privileges
// alone can't stop a query that says `USE org-<other>`. Every form of naming a database goes
// through a USE clause (plain, backtick-quoted, composite `a.b`, graph.byName, graph.byElementId,
// in a subquery or after UNION), so any USE keyword outside strings and comments is refused.

export class GraphQueryRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GraphQueryRefused';
  }
}

// Strings, quoted names and comments can't hold a USE clause, so they are blanked before the check.
// A backtick-quoted name after USE still leaves the USE keyword itself in the text.
const NOT_CODE = /'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"|`(?:[^`]|``)*`|\/\/[^\r\n]*|\/\*[\s\S]*?\*\//g;
const USE_KEYWORD = /\bUSE\b/i;

/** Throws GraphQueryRefused when `cypher` names a database, or isn't text (fail safe). */
export function assertNoDatabaseReference(cypher: string): void {
  if (typeof cypher !== 'string') throw new GraphQueryRefused('Graph query must be text');
  if (USE_KEYWORD.test(cypher.replace(NOT_CODE, ' '))) {
    throw new GraphQueryRefused('Graph queries may not name a database (USE)');
  }
}
