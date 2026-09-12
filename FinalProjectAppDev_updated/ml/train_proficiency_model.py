"""
ITern — Proficiency Classifier Training Script
===============================================================================
This is the actual trained ML component of the matching pipeline. It answers
a different question than the keyword extractor in skill_matcher.py:

  skill_matcher.py's extract_skills()  -> "which skills are MENTIONED?"
                                            (rule-based keyword matching)
  this script's trained model          -> "HOW PROFICIENT does the phrasing
                                            around that mention sound?"
                                            (supervised ML: TF-IDF + Logistic
                                             Regression, trained on labeled
                                             example sentences)

Why a separate trained model for this specific sub-task rather than the whole
pipeline: skill *detection* is a controlled vocabulary lookup problem (a fixed,
known list of skill names) where keyword matching is the correct, standard
tool — it's what real ATS systems do. Skill *proficiency* is a genuinely
open-ended language problem ("expert in X" vs "just started learning X" can
be phrased a thousand ways), which is exactly the kind of problem supervised
text classification is built for.

Data: we don't have access to a real labeled corpus of resumes with confirmed
proficiency levels, so this script generates a labeled training set from
phrasing templates (~10 per class) crossed with ~15 different skill/subject
names, producing ~450 labeled examples. This is disclosed here and in the
project writeup rather than presented as real-world data — the model and
training process are genuinely real; the dataset is a documented synthetic
stand-in for one, which is a common and defensible approach when real labeled
data isn't available on a class-project timeline.

Run (only needed if you want to retrain — the trained model is already
included in this project):
    cd ml
    pip install -r requirements.txt -r requirements-training.txt
    python3 train_proficiency_model.py

Produces:
    ml/models/proficiency_vectorizer.joblib
    ml/models/proficiency_model.joblib
    ml/models/proficiency_model_pure.json   <- what skill_matcher.py actually uses (pure Python, no sklearn needed to run it)
    ml/models/training_report.txt           <- accuracy + classification report, for your writeup/defense
===============================================================================
"""

import random
import joblib
from sklearn.feature_extraction.text import TfidfVectorizer
from sklearn.linear_model import LogisticRegression
from sklearn.model_selection import train_test_split
from sklearn.metrics import accuracy_score, classification_report

random.seed(42)

# --------------------------------------------------------------------------
# 1. Build the labeled training set
# --------------------------------------------------------------------------
SKILLS = [
    "JavaScript", "Python", "React", "SQL", "Java", "Node.js", "Docker",
    "AWS", "Figma", "Excel", "C++", "Spring Boot", "system design", "CSS",
    "Git", "machine learning", "data analysis", "project management",
]

ADVANCED_TEMPLATES = [
    "Expert in {s} with over 5 years of professional experience",
    "Senior {s} developer, led multiple production projects",
    "Extensive hands-on experience with {s} in enterprise environments",
    "Highly proficient in {s}, mentored junior engineers on the team",
    "Advanced knowledge of {s}, contributed to major open source projects",
    "5+ years building scalable systems using {s}",
    "Led the {s} architecture for a team of ten engineers",
    "Deep expertise in {s} gained through years of production use",
    "Recognized as the go-to expert for {s} within the company",
    "Architected and optimized large-scale {s} applications for production",
]

INTERMEDIATE_TEMPLATES = [
    "Familiar with {s}, used it in academic and personal projects",
    "Two years of experience working with {s}",
    "Comfortable using {s} for small to medium sized projects",
    "Completed several projects using {s} during a summer internship",
    "Working knowledge of {s} from coursework and independent practice",
    "Used {s} to build a few side projects over the past year",
    "Moderate experience with {s}, still actively improving",
    "Took a course on {s} and applied it in a class project",
    "Contributed to a team project that relied heavily on {s}",
    "Some hands-on experience with {s} in a professional internship setting",
]

BEGINNER_TEMPLATES = [
    "Currently learning {s} through online tutorials",
    "Basic understanding of {s} from an introductory course",
    "New to {s}, exploring it through personal practice",
    "Just started learning {s} this semester",
    "Limited exposure to {s}, currently building foundational skills",
    "Beginner level knowledge of {s}",
    "Took an intro workshop on {s} last month",
    "Recently began experimenting with {s} in small exercises",
    "Studying {s} as part of a coding bootcamp curriculum",
    "First exposure to {s} was in a school project this year",
]

TEMPLATE_SETS = [
    (ADVANCED_TEMPLATES, "Advanced"),
    (INTERMEDIATE_TEMPLATES, "Intermediate"),
    (BEGINNER_TEMPLATES, "Beginner"),
]

texts, labels = [], []
for templates, label in TEMPLATE_SETS:
    for template in templates:
        for skill in SKILLS:
            texts.append(template.format(s=skill))
            labels.append(label)

print(f"Built {len(texts)} labeled training examples "
      f"({len(SKILLS)} skills x {len(ADVANCED_TEMPLATES)} templates x 3 classes)")

# --------------------------------------------------------------------------
# 2. Train/test split — held out data the model never sees during training,
#    used purely to report honest accuracy.
# --------------------------------------------------------------------------
X_train, X_test, y_train, y_test = train_test_split(
    texts, labels, test_size=0.2, random_state=42, stratify=labels
)

# --------------------------------------------------------------------------
# 3. Vectorize (TF-IDF, unigrams + bigrams so phrases like "just started" or
#    "5+ years" are captured, not just single words) and train.
# --------------------------------------------------------------------------
vectorizer = TfidfVectorizer(ngram_range=(1, 2), min_df=1, stop_words="english")
X_train_vec = vectorizer.fit_transform(X_train)
X_test_vec = vectorizer.transform(X_test)

model = LogisticRegression(max_iter=1000, class_weight="balanced")
model.fit(X_train_vec, y_train)

# --------------------------------------------------------------------------
# 4. Evaluate honestly on the held-out test set.
# --------------------------------------------------------------------------
y_pred = model.predict(X_test_vec)
accuracy = accuracy_score(y_test, y_pred)
report = classification_report(y_test, y_pred)

print(f"\nTest accuracy: {accuracy:.2%}\n")
print(report)

with open("models/training_report.txt", "w") as f:
    f.write("ITern Proficiency Classifier — Training Report\n")
    f.write("=" * 50 + "\n")
    f.write(f"Training examples: {len(X_train)}\n")
    f.write(f"Test examples: {len(X_test)}\n")
    f.write(f"Test accuracy: {accuracy:.2%}\n\n")
    f.write(report)

# --------------------------------------------------------------------------
# 5. Save the trained artifacts for skill_matcher.py to load at inference time.
# --------------------------------------------------------------------------
joblib.dump(vectorizer, "models/proficiency_vectorizer.joblib")
joblib.dump(model, "models/proficiency_model.joblib")
print("\nSaved models/proficiency_vectorizer.joblib and models/proficiency_model.joblib")

# --------------------------------------------------------------------------
# 6. Quick sanity check on sentences the model never saw at all (not even a
#    held-out split of the same templates — brand new phrasing).
# --------------------------------------------------------------------------
sanity_examples = [
    "Built several production APIs using Node.js over the last four years",
    "Just started poking around with Docker last week",
    "Used Excel a bit in a couple of group projects",
]
print("\nSanity check on unseen phrasing:")
for text in sanity_examples:
    pred = model.predict(vectorizer.transform([text]))[0]
    print(f"  {pred:<14} <- \"{text}\"")

# --------------------------------------------------------------------------
# 7. Auto-export the pure-Python version skill_matcher.py actually loads —
#    see export_pure_model.py for full detail on why this exists.
# --------------------------------------------------------------------------
print("\nExporting pure-Python deployment model...")
import subprocess
subprocess.run(["python3", "export_pure_model.py"], check=True)
