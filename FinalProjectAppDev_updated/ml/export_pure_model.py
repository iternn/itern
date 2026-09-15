"""
Exports the trained TF-IDF + Logistic Regression model (produced by
train_proficiency_model.py) into a single plain-JSON file containing nothing
but numbers and strings — no numpy arrays, no pickled sklearn objects.

Why: sklearn/numpy/scipy ship compiled native code (.dll / .so files), which
some locked-down Windows machines (school-managed devices with Smart App
Control / Application Control enabled) refuse to run at all, regardless of
which folder they're installed in. Training still genuinely uses sklearn
(this script needs it, run once wherever sklearn works) — but the *deployed*
inference code in skill_matcher.py re-implements the trained model's math by
hand in pure Python, so the machine actually running the service never needs
numpy/scipy/sklearn installed at all.

Run this once after train_proficiency_model.py, in an environment where
scikit-learn works (it does not need to be the same machine that runs
skill_matcher.py):

    python export_pure_model.py

Produces: models/proficiency_model_pure.json
"""

import json
import joblib

vectorizer = joblib.load("models/proficiency_vectorizer.joblib")
model = joblib.load("models/proficiency_model.joblib")

export = {
    # term (unigram or bigram, exactly as sklearn tokenized it) -> column index
    "vocabulary": {term: int(idx) for term, idx in vectorizer.vocabulary_.items()},
    # idf weight per column index, aligned with the vocabulary above
    "idf": [float(x) for x in vectorizer.idf_],
    # sklearn's built-in English stop word list, so pure-Python tokenization
    # matches training exactly
    "stop_words": sorted(vectorizer.get_stop_words()),
    "ngram_range": list(vectorizer.ngram_range),
    # multinomial logistic regression weights
    "classes": list(model.classes_),
    "coef": [[float(x) for x in row] for row in model.coef_],
    "intercept": [float(x) for x in model.intercept_],
}

with open("models/proficiency_model_pure.json", "w") as f:
    json.dump(export, f)

print(f"Exported {len(export['vocabulary'])} vocabulary terms, "
      f"{len(export['classes'])} classes -> models/proficiency_model_pure.json")

# --------------------------------------------------------------------------
# Sanity check: verify the pure-Python re-implementation (copied inline here)
# produces the SAME predictions as the original sklearn model, before trusting
# it to run standalone in skill_matcher.py.
# --------------------------------------------------------------------------
import math
import re

TOKEN_PATTERN = re.compile(r"(?u)\b\w\w+\b")


def tokenize(text, stop_words, ngram_range):
    words = [w for w in TOKEN_PATTERN.findall(text.lower()) if w not in stop_words]
    tokens = list(words)
    if ngram_range[1] >= 2:
        tokens += [f"{words[i]} {words[i+1]}" for i in range(len(words) - 1)]
    return tokens


def predict_pure(text, export):
    tokens = tokenize(text, set(export["stop_words"]), export["ngram_range"])
    counts = {}
    for t in tokens:
        if t in export["vocabulary"]:
            counts[t] = counts.get(t, 0) + 1

    vec = {}
    for term, count in counts.items():
        idx = export["vocabulary"][term]
        vec[idx] = count * export["idf"][idx]

    norm = math.sqrt(sum(v * v for v in vec.values())) or 1.0
    vec = {idx: v / norm for idx, v in vec.items()}

    scores = []
    for c in range(len(export["classes"])):
        s = export["intercept"][c]
        for idx, val in vec.items():
            s += export["coef"][c][idx] * val
        scores.append(s)

    best = max(range(len(scores)), key=lambda i: scores[i])
    return export["classes"][best]


test_sentences = [
    "Built several production APIs using Node.js over the last four years",
    "Just started poking around with Docker last week",
    "Used Excel a bit in a couple of group projects",
    "Senior Python developer, led multiple production projects",
]

print("\nVerifying pure-Python predictions match sklearn's original predictions:")
all_match = True
for text in test_sentences:
    sklearn_pred = model.predict(vectorizer.transform([text]))[0]
    pure_pred = predict_pure(text, export)
    match = "OK" if sklearn_pred == pure_pred else "MISMATCH"
    if sklearn_pred != pure_pred:
        all_match = False
    print(f"  [{match}] sklearn={sklearn_pred:<14} pure={pure_pred:<14} <- \"{text}\"")

print("\nAll predictions match!" if all_match else "\nWARNING: some predictions differ — do not ship yet.")