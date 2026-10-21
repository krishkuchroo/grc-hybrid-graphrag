# Training Qwen3.5-4B in Google Colab

This folder holds the training notebook, `train-qwen3.5-4b.ipynb`, and the steps to run it. The notebook teaches
Qwen3.5-4B, the text model the app uses through Unsloth Studio (D243), the app's own AI jobs from made-up training
rows. It trains a small LoRA add-on with Unsloth, merges it into the model and gives you one 4-bit GGUF file to load in
Unsloth Studio (D248).

It is the "train" step of measure, train, measure (D239): the before-test runs first, on the untrained model, and the
after-test runs last, on the trained one.

- **Where:** free Google Colab, on a T4 GPU (D247).
- **How long:** about 3–5 hours, using about 6–10 GB of the GPU's memory (D246). It can take longer; the progress bar
  shows the time left.
- **What leaves the Mac:** only the made-up training file, `train.jsonl` (D247, D248). No org's data, and never the
  held-out test set (D234, D239).
- **No keys or passwords:** the base model is public, so the notebook needs no Hugging Face token, and nothing from
  `.env` goes into Colab. Colab may say that no Hugging Face token is set: that's fine.

## Before you start

- The before-test has run on the untrained model, and you have chosen the jobs to train from its results (training
  question 2).
- You know which 4-bit file Unsloth Studio loaded for the before-test, for example Q4_K_M or IQ4_XS. See "Matching the
  4-bit file" below (Q-TR-4).
- A Google account whose Drive has about 5 GB free.

## Steps

1. **Build the training file on the Mac.** In the project folder, run
   `pnpm train:data --jobs <the jobs chosen after the before-test>` (TR-001), for example `--jobs extraction`. It
   writes `data/generated/training/<name>/train.jsonl`, plus a `manifest.json` that stays on the Mac. Only this made-up
   file leaves the Mac (D247).
2. **Upload it to Google Drive.** In My Drive, make a folder named `grc-training` and upload `train.jsonl` into it.
3. **Open the notebook in Colab.** Go to https://colab.research.google.com, choose **File → Upload notebook** and pick
   `docs/training/train-qwen3.5-4b.ipynb` from this repository. Then choose **Runtime → Change runtime type → T4 GPU**
   and save.
4. **Run it.** Choose **Runtime → Run all**. Colab asks for access to your Google Drive: allow it. The notebook installs
   its libraries, checks every row of the file, trains, runs the validation check and exports the GGUF file. If Colab
   disconnects, reconnect and choose **Run all** again: it carries on from the last checkpoint (see "If Colab
   disconnects").
5. **Load the model in Unsloth Studio.** In Google Drive, download `grc-training/qwen3.5-4b-grc-<run>.Q4_K_M.gguf` (the
   notebook prints its exact name and size; the ending follows `QUANT`). Keep it outside this repository, for example
   in `~/models/grc/`: model files are never committed (D81). In Unsloth Studio, add that folder as a model folder and
   load the model with at least 8,192 tokens of context, with Studio on a port other than 8888, as for the before-test
   (D236).
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
  `grc-training/checkpoints`. A checkpoint is saved at most about 15 minutes apart, so at most that much training is
  done twice.
- Finished parts aren't done again: a finished training loads its saved adapter, a finished validation check prints
  its saved table, and a finished export prints the file's name.
- Only the export left? Run the Settings cell (2) and the Install cell (3), then the Export cell (9): it reloads the
  saved adapter from Drive.
- Free Colab limits GPU time per day. If Colab won't give you a GPU, try again later: nothing is lost.
- **Drive space:** each new checkpoint replaces an older one, and Google Drive moves the old one to its Bin, which
  still counts against your space. If Drive gets full, empty the Bin (drive.google.com → Bin → Empty bin) and choose
  Run all again. The newest checkpoints are never in the Bin.

## What the validation table means

At the end the notebook checks the trained model on the file's validation rows: about 10% of the rows, from generated
companies it never trained on. The table is printed and saved in Drive as `grc-training/validation.json`.

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
- These numbers come from made-up data. The real measure is the after-test compared with the before-test (D239).

## Matching the 4-bit file (Q-TR-4)

The after-test must use the same kind of 4-bit file as the before-test, so the two tests compare like for like (D243).
Set `QUANT` in the notebook's Settings cell before step 4. Unsloth's export can make `q4_k_m` (the default), `q4_k_s`,
`q4_0` or `q4_1`. It can't make IQ4_XS: if the before-test used IQ4_XS, run both tests with Q4_K_M.

Even with the same name, the files Unsloth publishes use Unsloth's own Dynamic 2.0 method, which keeps some layers at
higher precision, while this export uses llama.cpp's standard method. The two can differ a little in size and
quality.

## Training again

To train again from the start, with a new `train.jsonl` or other settings, first delete or rename the `checkpoints`
and `adapter` folders in `grc-training`. The notebook stops with a plain message if it finds another training's files
there. `validation.json` and the earlier GGUF file can stay: the GGUF's name carries its training's tag.

Keep the repository's notebook as it is: the committed copy has no outputs, so don't save a run's notebook from Colab
over it.

## What is where

| In Google Drive, `grc-training/`    | What                                                            |
| ----------------------------------- | --------------------------------------------------------------- |
| `train.jsonl`                       | the made-up training file you uploaded                          |
| `checkpoints/`                      | the last 2 checkpoints while training, and `run.json` naming it |
| `adapter/`                          | the trained LoRA add-on, saved when training ends               |
| `validation.json`                   | the validation table                                            |
| `qwen3.5-4b-grc-<run>.<QUANT>.gguf` | the merged 4-bit model for Unsloth Studio                       |
