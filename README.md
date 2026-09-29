# GRC Hybrid GraphRAG

A risk and compliance app (like ServiceNow IRM) with a smart search and chat built in.

## What it does

Companies track their **assets**, the **risks** to them, the **controls** that reduce those risks, their **policies**, and their **incidents**. This app keeps all of that in one place, maps it to frameworks like NIST 800-53, CSF 2.0, ISO 27001 and SOC 2, and lets you ask questions about it in plain English.

## The idea we are testing

Most AI search only looks for text that *sounds* similar to your question. We add a second path: a **graph** of how things connect (this server runs that app, which is exposed to this risk, which is reduced by that control). The app searches both ways and merges the results.

The goal is to **prove with benchmarks** that this "hybrid" search gives better answers than text search alone.

## How it works

- You upload documents, tickets, audit findings or asset lists.
- The AI (Gemma, running locally) reads them and pulls out records and links.
- Links it is sure about go live. Links it is unsure about wait for a person to approve.
- When you ask a question, the app searches the text **and** the graph, combines the two, and answers with sources.

## Built with

- **App:** TypeScript, NestJS (backend), React (frontend)
- **Data:** Neo4j (the graph), Postgres with pgvector (users, text, search), SeaweedFS (files)
- **AI:** Gemma and bge-m3, both run locally through Ollama, so no data leaves the machine

## Security in short

- Every company's data is walled off from every other company, in the app and in the databases.
- Each person only sees what their role and clearance allow.
- Every change is recorded in an audit trail that can't be edited.
- Sign-in needs a password and a second factor (MFA).

## Agent monitor

The build agents can be watched live at **http://127.0.0.1:4800**. It shows milestone progress, what each agent is doing, the task board and any guard-rail blocks, and it can send an agent a note.

Start it from the project folder with `node .claude/monitor/server.mjs`. It only listens on this machine (127.0.0.1).

## Status

Work in progress. The foundation (database setup, the wall between companies, roles, sign-in) is being built now, followed by 8 feature slices ending with the dashboard and the benchmark.
