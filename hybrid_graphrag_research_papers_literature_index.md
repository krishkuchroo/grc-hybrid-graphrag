# HYBRID GRAPHRAG & COMPLIANCE AI RESEARCH INDEX

This index contains key academic research papers, technical reports, and foundational literature covering **Knowledge Graphs + Vector RAG Integration**, **Multi-Hop Reasoning**, and **AI Application in GRC/Compliance**.

---

### Section 1: Foundational Hybrid & GraphRAG Architectures

#### 1. From Local to Global: A GraphRAG Approach to Query-Focused Summarization
* **Authors:** Darren Edge, Ha Trinh, Newman Cheng, Joshua Bradley, Alex Chao, Apratim Moxi, Shilin Lu, Jonathan Larson (Microsoft Research, 2024)
* **ArXiv ID:** [arXiv:2404.16130](https://arxiv.org/abs/2404.16130)
* **Core Takeaway:** Demonstrates how structuring raw documents into a hierarchical knowledge graph using community detection (Leiden algorithm) outperforms standard vector RAG on global context and complex multi-document summarization.

#### 2. RAPTOR: Recursive Abstractive Processing for Tree-Organized Retrieval
* **Authors:** Parth Sarthi, Salman Abdullah, Shubh Khanna, Christopher D. Manning (Stanford University, 2024)
* **ArXiv ID:** [arXiv:2401.18059](https://arxiv.org/abs/2401.18059)
* **Core Takeaway:** Introduces a tree-structured hierarchical retrieval method by recursively clustering and summarizing text segments. Allows the LLM to query across multiple levels of abstraction simultaneously.

#### 3. GRAG: Graph Retrieval-Augmented Generation
* **Authors:** Hwei-Jiun Hu et al. (2024)
* **ArXiv ID:** [arXiv:2405.16506](https://arxiv.org/abs/2405.16506)
* **Core Takeaway:** Solves multi-hop graph reasoning over networked documents by splitting search into sub-graph retrieval and dual-view (text view + graph view) context integration.

---

### Section 2: Knowledge Graph Extraction & Construction Pipelines

#### 4. Enhancing Knowledge Graph Construction Using Large Language Models
* **Authors:** Milena Trajanoska et al. (2023)
* **ArXiv ID:** [arXiv:2305.03801](https://arxiv.org/abs/2305.03801)
* **Core Takeaway:** Evaluates the accuracy of LLMs in automated Named Entity Recognition (NER) and Relation Extraction (RE) from unstructured corporate text without requiring human-labeled training sets.

#### 5. Hybrid Search with Knowledge Graphs and Vector Retrieval
* **Publication:** *ResearchGate Literature Index on Search Optimization*
* **Core Takeaway:** Demonstrates the use of **Reciprocal Rank Fusion (RRF)** as a mathematical approach to merge ranking scores from graph query traversals and dense vector similarity scores.

---

### Section 3: Key Mathematical Formulations

#### Reciprocal Rank Fusion (RRF) Formula
RRF calculates a unified score across multiple retrieval paths without requiring score normalization:

$$RRF\_Score(d \in D) = \sum_{m \in M} \frac{1}{k + r_m(d)}$$

Where:
* $M$ = set of retrieval systems (e.g., Vector Search, Cypher Graph Search)
* $r_m(d)$ = rank of document/node $d$ in retrieval system $m$
* $k$ = smoothing constant (typically set to $60$)

#### Graph Traversal Precision vs Vector Recall
Traditional Vector Cosine Similarity:

$$\text{Similarity}(A, B) = \frac{A \cdot B}{\|A\| \|B\|}$$

While vector similarity measures semantic proximity in $n$-dimensional space, **Graph Distance** provides strict path constraints:

$$\text{PathDistance}(u, v) = \min \{ \text{length}(P) \mid P \text{ is a path from } u \text{ to } v \}$$

Combining both guarantees that retrieved text chunks are both **semantically relevant** ($\text{Cosine Similarity}$) and **operationally linked** ($\text{PathDistance} < N$).