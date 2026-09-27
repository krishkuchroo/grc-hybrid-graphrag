# SYSTEM ARCHITECTURE SPECIFICATION
## System Name: Enterprise Integrated Risk Management (IRM) Engine
## Architecture Pattern: Dual-Path Hybrid GraphRAG (Vector Search + Cypher Graph Traversal)

---

### 1. High-Level Data Flow Topology

```
+-----------------------------------------------------------------------------------+
|                               Enterprise Data Ingestion                          |
|  [Enterprise CMDB]       [Policy Management PDF/Doc]      [Audit & SOC Logs]     |
+-----------------------------------+-----------------------------------------------+
                                    |
                                    v
+-----------------------------------------------------------------------------------+
|                        Hybrid Indexing & ETL Pipeline                             |
|  +-------------------------------------+  +------------------------------------+  |
|  | Vector Extraction & Chunking        |  | Entity & Relationship Extraction   |  |
|  | - Chunks (500 tokens, 50 overlap)   |  | - Canonical Entity Resolution      |  |
|  | - Embedding Model: text-embedding-3 |  | - LLM-based Triple Generation      |  |
|  +------------------+------------------+  +-----------------+------------------+  |
+---------------------|---------------------------------------|---------------------+
                      v                                       v
+----------------------------------------+ +----------------------------------------+
|        Vector Store (Qdrant/pgvector)  | |         Knowledge Graph (Neo4j)        |
| - High-dimensional Dense Vector Index  | | - Relational Entity-Control-Asset Graph|
+---------------------+------------------+ +------------------+---------------------+
                      |                                       |
                      +-------------------+-------------------+
                                          |
                                          v
+-----------------------------------------------------------------------------------+
|                             Dual-Path Execution Engine                            |
|                                                                                   |
|    Path A: Semantic Vector Search             Path B: Multi-Hop Graph Traversal   |
|    - Top-K Cosine Similarity Search           - N-Hop Cypher Traversal Queries    |
|    - Unstructured Text Context               - Deterministic Dependency Tree      |
|                                                                                   |
|                                  [Fusion Engine]                                  |
|                            - Reciprocal Rank Fusion (RRF)                         |
|                            - Entity-Grounded Context Filter                       |
+-----------------------------------+-----------------------------------------------+
                                    |
                                    v
+-----------------------------------------------------------------------------------+
|                          LLM Context Assembly & Generation                        |
|  - System Prompt with Hard-Bound Graph Constraints + Semantic Text Chunks         |
+-----------------------------------------------------------------------------------+
```

---

### 2. Neo4j Knowledge Graph Schema (GRC Ontology)

#### Node Labels
* `:Asset` (Attributes: `id`, `name`, `type`, `criticality`, `owner`, `data_classification`)
* `:Risk` (Attributes: `id`, `title`, `impact_score`, `likelihood_score`, `financial_exposure`)
* `:Control` (Attributes: `id`, `code`, `framework`, `status`, `last_tested_date`)
* `:Policy` (Attributes: `id`, `title`, `version`, `effective_date`)
* `:Incident` (Attributes: `id`, `severity`, `status`, `timestamp`)

#### Edge Relationships
* `(:Asset)-[:HOSTS|RUNS]->(:Asset)`
* `(:Asset)-[:EXPOSED_TO]->(:Risk)`
* `(:Risk)-[:MITIGATED_BY]->(:Control)`
* `(:Control)-[:GOVERNED_BY]->(:Policy)`
* `(:Incident)-[:IMPACTS]->(:Asset)`
* `(:Incident)-[:EXPOSES]->(:Risk)`

#### Cypher Schema Setup Script
```cypher
CREATE CONSTRAINT FOR (a:Asset) REQUIRE a.id IS UNIQUE;
CREATE CONSTRAINT FOR (r:Risk) REQUIRE r.id IS UNIQUE;
CREATE CONSTRAINT FOR (c:Control) REQUIRE c.id IS UNIQUE;
CREATE CONSTRAINT FOR (p:Policy) REQUIRE p.id IS UNIQUE;

CREATE INDEX asset_type_idx FOR (a:Asset) ON (a.type);
CREATE INDEX control_framework_idx FOR (c:Control) ON (c.framework);
```

---

### 3. Dual-Path Retrieval & Fusion Algorithm

```python
import numpy as np
from typing import List, Dict, Any

def reciprocal_rank_fusion(
    vector_results: List[Dict[str, Any]], 
    graph_results: List[Dict[str, Any]], 
    k: int = 60
) -> List[Dict[str, Any]]:
    """
    Combines dense vector retrieval scores with graph traversal results 
    using Reciprocal Rank Fusion (RRF).
    """
    rrf_scores = {}

    # Process Vector Path Ranks
    for rank, doc in enumerate(vector_results):
        doc_id = doc["id"]
        if doc_id not in rrf_scores:
            rrf_scores[doc_id] = {"score": 0.0, "payload": doc}
        rrf_scores[doc_id]["score"] += 1.0 / (k + (rank + 1))

    # Process Graph Path Ranks
    for rank, node in enumerate(graph_results):
        node_id = node["id"]
        if node_id not in rrf_scores:
            rrf_scores[node_id] = {"score": 0.0, "payload": node}
        rrf_scores[node_id]["score"] += 1.0 / (k + (rank + 1))

    # Sort candidates by combined RRF Score
    sorted_candidates = sorted(
        rrf_scores.values(), 
        key=lambda x: x["score"], 
        reverse=True
    )
    return sorted_candidates
```

---

### 4. Implementation Guidelines for Claude Code CLI

When executing code generation or deployment commands for this architecture using Claude Code CLI, adhere to the following setup parameters:

1. **Databases Required:** 
   * Neo4j Enterprise / AuraDB (Graph Traversal Engine)
   * Qdrant or `pgvector` (Dense Vector Storage)
2. **Context Window Configuration:** 
   * Format context for LLM prompts with strict sectioning (`<GRAPH_CONTEXT>` vs `<UNSTRUCTURED_DOCUMENT_CONTEXT>`).
   * Explicitly direct the model to treat `<GRAPH_CONTEXT>` as ground truth facts for entity relationships to eliminate hallucinated multi-hop paths.