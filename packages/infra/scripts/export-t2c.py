# Exports neo4j/text2cypher-2024v1's two parquet files to one JSON Lines file for
# packages/infra/scripts/train-data-t2c.ts. Line 1: {"sources": [{file, sha256, rows}]}; then one
# row per line, in file order: {file, question, cypher, data_source, instance_id, database_reference_alias}.
# The schema column is left out (the conversion never reads it). Run: python -I export_t2c.py <dir> <out>
import hashlib, json, sys
import pyarrow.parquet as pq

src, out = sys.argv[1], sys.argv[2]
FILES = ['train-00000-of-00001.parquet', 'test-00000-of-00001.parquet']
COLS = ['question', 'cypher', 'data_source', 'instance_id', 'database_reference_alias']
sources, lines = [], []
for f in FILES:
    path = f'{src}/{f}'
    with open(path, 'rb') as fh:
        digest = hashlib.sha256(fh.read()).hexdigest()
    rows = pq.read_table(path, columns=COLS).to_pylist()
    sources.append({'file': f, 'sha256': digest, 'rows': len(rows)})
    for r in rows:
        lines.append(json.dumps({'file': f, **{c: r[c] for c in COLS}}, ensure_ascii=False, separators=(',', ':')))
with open(out, 'w', encoding='utf-8', newline='\n') as fh:
    fh.write(json.dumps({'sources': sources}, separators=(',', ':')) + '\n')
    for line in lines:
        fh.write(line + '\n')
print(json.dumps(sources))
