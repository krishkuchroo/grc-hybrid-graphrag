# Training Qwen3.5-4B in Google Colab

This folder holds the training notebook, `train-qwen3.5-4b.ipynb`, and the steps to run it. The notebook teaches
Qwen3.5-4B, the text model the app uses through Unsloth Studio (D243), the app's own AI jobs from training rows
built from real public data. It trains a small LoRA add-on with Unsloth, merges it into the model and gives you one 4-bit GGUF file to load in
Unsloth Studio (D248).

It is the "train" step of measure, train, measure (D239): the before-test runs first, on the untrained model, and the
after-test runs last, on the trained one.

- **Where:** free Google Colab, on a T4 GPU (D247).
- **How long:** round 2's file (4,423 rows, 1 pass: about 990 steps) takes about 6–7 hours on a T4 at about 23 s a
  step, roughly half on an L4, then the validation check and the export, using about 6–10 GB of the GPU's memory. If Colab disconnects, it resumes from
  the Drive checkpoints (see "If Colab disconnects", which also says how to keep Drive space free). The progress bar
  shows the time left. The base file for the before-test, below, takes about 20–30 minutes.
- **What leaves the Mac:** only the training file, `train.jsonl`, built from public data (D247, D248). No org's data, and never the
  held-out test set (D234, D239).
- **Progress in Drive:** every loss line, checkpoint, check result and the export are added to
  `grc-training/progress-<tag>.txt` as they happen (one short line every 10 steps, so training isn't slowed). Open it
  in Drive any time, even when the Colab page has refreshed or disconnected.
- **No keys or passwords:** the base model is public, so the notebook needs no Hugging Face token, and nothing from
  `.env` goes into Colab. Colab may say that no Hugging Face token is set: that's fine.

## First: the base file for the before-test (D253)

The before-test runs on the untrained Qwen3.5-4B exported by this notebook, the same way the trained model is exported
later, so both tests load files made the same way. Set `BASE_ONLY = True` and the notebook only exports the untrained
model: it needs no training file and trains nothing.

1. **Make the Drive folder.** In My Drive, make a folder named `grc-training`. Nothing needs uploading.
2. **Open the notebook in Colab.** Go to https://colab.research.google.com, choose **File → Upload notebook** and pick
   `docs/training/train-qwen3.5-4b.ipynb` from this repository. Then choose **Runtime → Change runtime type → T4 GPU**
   and save.
3. **Choose base-only mode.** In the Settings cell, set `BASE_ONLY = True`. Leave `QUANT` at `q4_k_m`.
4. **Run it.** Choose **Runtime → Run all** and allow Drive access. It takes about 20–30 minutes; the training cells
   say they are skipped. If Colab disconnects, reconnect and choose **Run all** again: a finished file isn't made twice
   (the notebook prints "Already exported").
5. **Download the file.** In Google Drive, download `grc-training/qwen3.5-4b-base.Q4_K_M.gguf` and keep it outside
   this repository, for example in `~/models/grc/`: model files are never committed (D81).
6. **Load it in the Unsloth desktop app.** The app runs on port 8888, so HexStrike must be off (D252). Add that folder
   as a model folder and load the file with at least 8,192 tokens of context and Parallel Slots 1.
7. **Point the app at it.** List the model IDs with the `curl` command in step 6 of "Steps" below, with `8888` as the
   port. Set `AI_TEXT_MODEL` in `.env` to the base file's ID, then rebuild grc-api and grc-worker and restart
   grc-caddy with the two commands in that step.
8. **Run the before-test** (D239) on this model. Don't use Unsloth's published GGUF for it (D253).

To train later, set `BASE_ONLY` back to `False` (the uploaded notebook from this repository already has `False`).

## Before you start

- The before-test has run on the untrained model, and you have chosen the jobs to train from its results (training
  question 2).
- The before-test ran on the base file from the section above (D253).
- A Google account whose Drive has about 5 GB free.

## Steps

1. **Get the training file on the Mac.** The current one is `data/generated/training/train-all/train.jsonl`: real
   public data (MITRE ATT&CK, NVD, CISA KEV, VCDB, text2cypher), built by `packages/infra/scripts/train-data-real.ts`
   and `train-data-t2c.ts` and joined. Its `manifest.json` stays on the Mac. Only this file leaves the Mac (D247).
2. **Upload it to Google Drive.** In My Drive, make a folder named `grc-training` and upload `train.jsonl` into it.
3. **Open the notebook in Colab.** Go to https://colab.research.google.com, choose **File → Upload notebook** and pick
   `docs/training/train-qwen3.5-4b.ipynb` from this repository. Then choose **Runtime → Change runtime type → T4 GPU**
   and save. In the Settings cell, check that `BASE_ONLY` is `False` (the default).
4. **Run it.** Choose **Runtime → Run all**. Colab asks for access to your Google Drive: allow it. The notebook installs
   its libraries, checks every row of the file, trains, runs the validation check and exports the GGUF file. If Colab
   disconnects, reconnect and choose **Run all** again: it carries on from the last checkpoint (see "If Colab
   disconnects").
5. **Load the model in Unsloth Studio.** In Google Drive, download `grc-training/qwen3.5-4b-grc-<run>.Q4_K_M.gguf` (the
   notebook prints its exact name and size; the ending follows `QUANT`). Keep it outside this repository, for example
   in `~/models/grc/`: model files are never committed (D81). In Unsloth Studio, add that folder as a model folder and
   load the model with at least 8,192 tokens of context, in the Unsloth desktop app on port 8888 with HexStrike off
   (D252), as for the before-test.
6. **Point the app at it.** List the model IDs Unsloth Studio serves, with your port in place of `<port>`:

   ```sh
   curl -s -H "Authorization: Bearer $(grep '^AI_TEXT_API_KEY=' .env | cut -d= -f2-)" http://127.0.0.1:<port>/v1/models
   ```

   The key is read from `.env` and never typed or shown. Set `AI_TEXT_MODEL` in `.env` to the trained model's ID.
   Nothing else in the app changes (D248). Then rebuild grc-api and grc-worker as CLAUDE.md says:

   ```sh
   docker compose -f packages/infra/compose.yaml -f packages/infra/compose.dev.yaml --env-file .env up -d --build grc-api grc-worker
   docker restart grc-caddy
   ```

7. **Run the after-test.** Run the same test as the before-test, the same way, now with the trained model (D239). The
   difference between the two scores is the evidence that training helped.

## If Colab disconnects

- Reconnect, choose **Runtime → Run all** and allow Drive access again. The notebook installs the libraries again (a
  few minutes), checks the file again and resumes training from the newest complete checkpoint in
  `grc-training/checkpoints`. A checkpoint is saved about every 20 minutes, so at most that much training is done
  twice.
- Finished parts aren't done again: a finished training loads its saved adapter, a finished validation check prints
  its saved table, and a finished export prints the file's name.
- Only the export left? Run the Settings cell (2) and the Install cell (3), then the Export cell (9): it reloads the
  saved adapter from Drive.
- Free Colab limits GPU time per day. If Colab won't give you a GPU, try again later: nothing is lost.
- **Drive space:** each new checkpoint replaces an older one, and Google Drive moves the old one to its Bin, which
  still counts against your space. If Drive gets full, empty the Bin (drive.google.com → Bin → Empty bin) and choose
  Run all again. The newest checkpoints are never in the Bin.

## What the validation table means

At the end the notebook checks the trained model on the file's validation rows: about 10% of the rows, held out from
training. The table is printed and saved in Drive as `grc-training/validation-<tag>.json`, after the validation loss
and after each job, so a disconnect only redoes the job it was on.

- **Validation loss:** how far the model's predictions are from the correct answers of the validation rows; lower is
  better. It's a quick health check: a value far above the last training loss means the model learnt the training rows
  by heart instead of the jobs.
- **Per job,** for up to 50 validation rows, the model writes its own answer with thinking off, always taking the most
  likely next word (so a rerun gives the same answers). Each answer is compared with the row's correct answer:
  - `extraction`, `mapping` and `graph_query`:
    - **parse as JSON:** the share of answers the app could read at all. In the app, the server holds the model to
      the answer's JSON shape while it writes, so the app's own share is at least as high.
    - **equal to the expected answer:** the share whose JSON equals the correct answer exactly: the same records,
      links and sentences, or the same query.
  - `answer`:
    - **cite only the given sources:** the share of answers whose `[n]` citations all point at source numbers that
      are in the question's context. An answer that cites nothing counts here; the next line shows whether it should
      have cited something.
    - **match exactly:** the share equal to the correct answer word for word. This is strict for free text: a correct
      answer worded differently counts as a miss.
- These numbers come from the file's own held-out rows. The real measure is the after-test compared with the before-test (D239).

## Matching the 4-bit file (Q-TR-4, answered: D253)

Both tests load files this notebook made with the same `QUANT`: the base file before (see "First: the base file for the
before-test") and the trained file after. Keep `QUANT` at `q4_k_m` for both runs.

Neither test uses the GGUF files Unsloth publishes. Even with the same name, those are made with Unsloth's own Dynamic
2.0 method, which keeps some layers at higher precision, while this notebook's export uses llama.cpp's standard method.
Comparing a published file with this export would mix the effect of training with the difference in how the files were
made.

## Training again

To train again from the start, with a new `train.jsonl` or other settings, first delete or rename the `checkpoints`
and `adapter` folders in `grc-training`. The notebook stops with a plain message if it finds another training's files
there. The earlier validation table, progress file and GGUF file can stay: their names carry their training's tag
(round 1's table is the untagged `validation.json`).

Keep the repository's notebook as it is: the committed copy has no outputs, so don't save a run's notebook from Colab
over it.

## What is where

| In Google Drive, `grc-training/`    | What                                                            |
| ----------------------------------- | --------------------------------------------------------------- |
| `train.jsonl`                       | the training file you uploaded                                  |
| `checkpoints/`                      | the last 2 checkpoints while training, and `run.json` naming it |
| `adapter/`                          | the trained LoRA add-on, saved when training ends               |
| `progress-<tag>.txt`                | each loss line, checkpoint, check result and the export, live   |
| `validation-<tag>.json`             | the validation table                                            |
| `qwen3.5-4b-base.<QUANT>.gguf`      | the untrained base for the before-test                          |
| `qwen3.5-4b-grc-<run>.<QUANT>.gguf` | the merged 4-bit model for Unsloth Studio                       |
