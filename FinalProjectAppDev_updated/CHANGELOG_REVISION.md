# ITern — Revision Pass (pre-defense)

## 🔴 Check this first — likely cause of "authentication isn't working"

Your `backend/.env` has:
```
CLIENT_ORIGIN=http://127.0.0.1:5500
```
If you open the frontend at `http://localhost:5500` instead of `http://127.0.0.1:5500`,
the browser and server disagree on origin and **every fetch() call silently fails**
CORS — OTP requests, login, everything. Two fixes, pick one:

- Always open the frontend at the exact URL in `.env` (`http://127.0.0.1:5500`), **or**
- Change `.env` to `CLIENT_ORIGIN=http://localhost:5500` if that's what you actually type,
  then restart `npm run dev` (dotenv only reads `.env` on startup).

Open your browser's DevTools → Console tab while trying to register. A CORS failure
shows as a red error mentioning "blocked by CORS policy" — if you see that, this was it.
If the error is something else entirely, send a screenshot and we'll chase that instead.

---

## What changed in this pass

### 1. Machine learning — now actually wired up
- **New:** `ml/skill_matcher.py` + `ml/requirements.txt` — FastAPI service that
  extracts skills from an uploaded PDF resume and scores applicants against postings.
- **Changed:** `backend/routes/interns.js` — the resume upload route now actually
  calls the ML service's `/extract-skills` endpoint (previously just a comment).
- `backend/routes/applications.js` already called `/score` correctly — it just had
  nothing listening on the other end until now.

**To run it** (separate terminal, alongside `npm run dev`):
```bash
cd ml
python3 -m venv venv
source venv/bin/activate        # Windows: venv\Scripts\activate
pip install -r requirements.txt
uvicorn skill_matcher:app --reload --port 8000
```

### 2. Downloadable resume template
- New file: `frontend/assets/files/ITern_Resume_Template.pdf`
- Linked from `student/register.html` (Step 4) and `student/profile.html`.
- The template's Skills section is intentionally plain-text and explicit — it
  doubles as a hint for reliable ML extraction.

### 3. Sidebar (`assets/js/nav.js`)
- Notification bell moved from the bottom user card to the top brand row.
- The user block (avatar + name) is now a link to `profile.html`.
- "Skills Test" renamed to "Verify Skills" in the nav, matching the reframed page (below).

### 4. Dashboards — real metrics
- **Student dashboard:** active applications, interviews scheduled, skills on
  profile, top match score.
- **Company dashboard:** active postings, total applicants, waitlisted count,
  average match score.
- All computed client-side from existing endpoints — no new backend routes needed.

### 5. Search / filter
- **Student Applications:** text search across company name + posting title.
- **Company Applicants:** text search (student name / school / posting) plus a
  status dropdown filter.

### 6. Skills Test → "Verify Resume Skills"
- Per your note: this page now only lists skills whose source is `resume_parse`
  (i.e. skills the ML extractor actually found in an uploaded resume) — not a
  free-for-all quiz picker. Passing moves that skill to a verified state.
- If a student hasn't uploaded a resume yet, the dropdown says so and the button
  disables, instead of silently doing nothing.

### 7. Company profile picture (replaces the photo gallery)
- **DB change required** — run `backend/db/migration_2026-09.sql`:
  ```sql
  ALTER TABLE companies ADD COLUMN profile_photo_path VARCHAR(255) NULL AFTER about;
  ```
- Rewrote `backend/routes/companies.js`: `POST /companies/photo` and
  `DELETE /companies/photo` replace the old gallery routes — one image per
  company, uploading a new one replaces (and deletes) the old file.
- Rewrote `company/profile.html` (circular picture + upload/remove) and
  `student/company-profile.html` (shows that one photo, or initials if none set).
- The old `company_photos` table still exists in your DB but is unused — see
  the migration file for an optional `DROP TABLE` once you've confirmed the
  new flow works.

### 8. Real trained ML model (proficiency classifier) — NEW
Your panel wanted an actual trained model, not just rule-based matching, so
this replaces the proficiency heuristic with a real one:

- **New:** `ml/train_proficiency_model.py` — builds a labeled dataset (~540
  example sentences across Beginner/Intermediate/Advanced), splits it into
  train/test (80/20), vectorizes with TF-IDF, and trains a Logistic
  Regression classifier with `model.fit(...)`. Prints accuracy + a full
  classification report, and saves the trained model + vectorizer to
  `ml/models/`.
- **Changed:** `skill_matcher.py`'s `estimate_level()` now loads that trained
  model at startup and uses `model.predict(...)` to score how proficient a
  resume sounds about a skill, replacing the old if/else keyword heuristic.
  Falls back to the old heuristic only if the model hasn't been trained yet
  (so the service never crashes if you forget this step).

**You must run this once before starting the ML service:**
```bash
cd ml
python3 train_proficiency_model.py
```
This is the actual "training" step — it prints the accuracy and saves
`ml/models/proficiency_model.joblib` + `proficiency_vectorizer.joblib`.
`ml/models/training_report.txt` also gets written for your documentation.

**How to explain this in your defense (be ready for this exact question):**
- *"What does it detect vs. what's trained?"* — Skill *detection* (does the
  resume mention "React" at all) is controlled-vocabulary keyword matching,
  same as real ATS systems use. Skill *proficiency* (how good they sound at
  it) is the trained part: a supervised text classifier learns to tell
  "expert in X, 5 years" apart from "just started learning X" from phrasing
  alone.
- *"Why is test accuracy 100%?"* — Be upfront about this rather than hoping
  it doesn't come up: the training sentences are built from 10 phrasing
  templates per class, so the test split reuses the same template families
  with different skill names substituted in — meaningful, but not as strong
  a claim as accuracy on truly independent data. What's stronger evidence:
  the script's final "sanity check" runs the model on three sentences that
  don't match any template pattern at all (e.g. "Built several production
  APIs using Node.js over the last four years"), and it classifies all three
  correctly. That generalization to genuinely unseen phrasing is the more
  meaningful result — lead with that if asked to defend the model.
- *"Why not train on real resumes?"* — No labeled, real-world dataset of
  resumes-with-confirmed-proficiency exists to use off the shelf, and
  collecting/labeling one wasn't feasible on this timeline. Documenting the
  synthetic dataset honestly (rather than presenting it as real-world data)
  is the correct call here — the training process itself, the model
  architecture, and the evaluation methodology are all genuine.

### 9. ML service rebuilt to be Windows-Application-Control-proof — IMPORTANT
Your school laptop's Windows Security "Application Control" policy blocks
unsigned compiled DLLs, no matter which folder they're in — and numpy,
scipy, and scikit-learn all ship compiled native code. This meant the ML
service could crash on your specific machine even with everything else
correct.

**Fix: the deployed service no longer uses numpy/scipy/scikit-learn at all.**
- The model is still genuinely trained with scikit-learn — that part didn't
  change (`train_proficiency_model.py`, real `.fit()` call, real train/test
  split, real accuracy metrics, all still there).
- What changed: `export_pure_model.py` exports the trained model's learned
  numbers (vocabulary, TF-IDF weights, logistic regression coefficients)
  into a plain `.json` file — just numbers and strings, no compiled objects.
- `skill_matcher.py` now re-implements the TF-IDF vectorization and logistic
  regression forward pass **by hand**, using only `re` and `math` (both
  built into Python, nothing to install, nothing compiled). It reads
  `models/proficiency_model_pure.json` and does the exact same math the
  trained model would — verified to produce **identical predictions** to
  the original scikit-learn model (see the sanity check output in
  `export_pure_model.py` — every test sentence matched exactly).
- Also swapped `pdfplumber` for `pypdf` for PDF text extraction — same
  reasoning, `pdfplumber` depends on a compiled PDF renderer (`pypdfium2`),
  `pypdf` is pure Python.
- **`ml/requirements.txt` is now much shorter** — only `fastapi`, `uvicorn`,
  `pypdf`, `mysql-connector-python`, `pydantic`, `python-dotenv`. None of
  these have caused Application Control issues in your testing so far.
- A **separate** `ml/requirements-training.txt` (scikit-learn + joblib) only
  matters if you want to retrain from scratch — you don't need to install it
  just to run the service, since the trained model is already exported and
  included at `models/proficiency_model_pure.json`.

**How to explain this in your defense if asked "why doesn't your ML service
import scikit-learn?":** the model is trained with scikit-learn (show
`train_proficiency_model.py` and `training_report.txt` as evidence) — the
production service re-implements the trained model's inference math in pure
Python for deployment portability, a legitimate and fairly common practice
(this is conceptually similar to how ONNX or "export to production" tooling
works in real ML systems — train with a full framework, deploy a lightweight
re-implementation of just the learned weights).



1. Run the migration SQL.
2. **Run `python3 train_proficiency_model.py` inside `ml/` once** — confirm it
   prints "Test accuracy: 100.00%" and the sanity-check predictions, and that
   `ml/models/*.joblib` files now exist.
3. Start all four processes: MySQL, `npm run dev` (backend), `uvicorn ...`
   (ML service), and your static file server for `frontend/`.
4. Check the ML terminal prints `[skill_matcher] Loaded trained proficiency
   classifier.` on startup — if it instead prints the WARNING about a missing
   model, step 2 wasn't run yet, or you're running uvicorn from the wrong folder.
5. Register a fresh student account → confirm no CORS error in the console.
6. Upload the resume template (fill it in first) → within a few seconds, check
   the Profile page shows extracted skills with source "resume_parse".
7. Go to Verify Skills → confirm only resume-parsed skills appear.
8. Apply to a posting → confirm the match score is a real, non-zero number
   (not always 0%, not always the same number).
9. Log in as the company → confirm the dashboard shows real counts, not dashes.
10. Try the search box on Applications/Applicants with a partial name.
11. Upload a company profile picture → confirm it shows on the student-facing
    company profile page too.
