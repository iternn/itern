"""
ITern - Skill Matching Service
===============================================================================
Two jobs:
  1. POST /extract-skills - reads an uploaded PDF resume, pulls skill mentions
     against a controlled vocabulary, and writes them into intern_skills
     (source='resume_parse').
  2. POST /score - computes a 0-100 match score between a student's skills
     and a posting's required skills. This is the single source of truth for
     match scores; backend/routes/applications.js calls this instead of
     trusting a client-supplied number.

IMPORTANT - no numpy/scipy/scikit-learn dependency at runtime:
This service deliberately avoids importing numpy, scipy, or scikit-learn.
Those packages ship compiled native code (.dll/.so files), which some
locked-down Windows machines (school-managed devices with Smart App Control /
Application Control enabled) refuse to run at all, regardless of install
location. The proficiency classifier WAS genuinely trained with scikit-learn
(see train_proficiency_model.py + export_pure_model.py) - its learned
weights are just re-implemented here by hand in plain Python (only `re` and
`math`, both standard library) so this service runs on machines that block
compiled extensions. Same reasoning for using `pypdf` instead of
`pdfplumber` for PDF text extraction - pure Python, no native code.

Run:
    cd ml
    python -m venv venv
    venv\\Scripts\\activate            (Windows)  /  source venv/bin/activate (Mac/Linux)
    pip install -r requirements.txt
    python -m uvicorn skill_matcher:app --reload --port 8000

Keep this running in its own terminal alongside `npm run dev` - the Node
backend calls it over HTTP at ML_SERVICE_URL (set in backend/.env).
===============================================================================
"""

import json
import math
import os
import re
from pathlib import Path

import mysql.connector
from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from pypdf import PdfReader

load_dotenv(dotenv_path=Path(__file__).resolve().parent / ".env")

app = FastAPI(title="ITern Skill Matcher")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

DB_CONFIG = dict(
    host=os.getenv("DB_HOST", "localhost"),
    user=os.getenv("DB_USER", "itern_app"),
    password=os.getenv("DB_PASSWORD", "changeme"),
    database=os.getenv("DB_NAME", "itern"),
)

print(f"[skill_matcher] DB config -> host={DB_CONFIG['host']} "
      f"user={DB_CONFIG['user']} database={DB_CONFIG['database']} "
      f"password_length={len(DB_CONFIG['password'])}")


def db():
    return mysql.connector.connect(**DB_CONFIG)


# --------------------------------------------------------------------------
# Trained proficiency classifier - pure-Python inference.
# The actual training (real data split, real .fit() call, real accuracy
# metrics) happens in train_proficiency_model.py using scikit-learn. This
# file only re-plays the learned weights by hand: TF-IDF vectorization +
# a multinomial logistic regression forward pass. See export_pure_model.py
# for how models/proficiency_model_pure.json is produced, and the
# verification step in that script confirming this reimplementation
# produces IDENTICAL predictions to the original sklearn model.
# --------------------------------------------------------------------------
_MODEL_PATH = os.path.join(os.path.dirname(__file__), "models", "proficiency_model_pure.json")
_TOKEN_PATTERN = re.compile(r"(?u)\b\w\w+\b")

try:
    with open(_MODEL_PATH) as f:
        _PROF_MODEL = json.load(f)
    _STOP_WORDS = set(_PROF_MODEL["stop_words"])
    print(f"[skill_matcher] Loaded trained proficiency classifier "
          f"({len(_PROF_MODEL['vocabulary'])} vocabulary terms, pure-Python inference).")
except FileNotFoundError:
    _PROF_MODEL = None
    print("[skill_matcher] WARNING: models/proficiency_model_pure.json not found - "
          "run train_proficiency_model.py then export_pure_model.py first. "
          "Falling back to a keyword heuristic for proficiency estimation.")


def _tokenize(text, ngram_range):
    words = [w for w in _TOKEN_PATTERN.findall(text.lower()) if w not in _STOP_WORDS]
    tokens = list(words)
    if ngram_range[1] >= 2:
        tokens += [f"{words[i]} {words[i + 1]}" for i in range(len(words) - 1)]
    return tokens


def _predict_proficiency(text: str) -> str:
    """Pure-Python TF-IDF + logistic regression forward pass, using the
    weights learned by the real training run. See module docstring."""
    tokens = _tokenize(text, _PROF_MODEL["ngram_range"])
    counts = {}
    for t in tokens:
        if t in _PROF_MODEL["vocabulary"]:
            counts[t] = counts.get(t, 0) + 1

    vec = {}
    for term, count in counts.items():
        idx = _PROF_MODEL["vocabulary"][term]
        vec[idx] = count * _PROF_MODEL["idf"][idx]

    norm = math.sqrt(sum(v * v for v in vec.values())) or 1.0
    vec = {idx: v / norm for idx, v in vec.items()}

    scores = []
    for c in range(len(_PROF_MODEL["classes"])):
        s = _PROF_MODEL["intercept"][c]
        for idx, val in vec.items():
            s += _PROF_MODEL["coef"][c][idx] * val
        scores.append(s)

    best = max(range(len(scores)), key=lambda i: scores[i])
    return _PROF_MODEL["classes"][best]


_LEVEL_MAP = {"Beginner": 35, "Intermediate": 65, "Advanced": 88}


# --------------------------------------------------------------------------
# Skill extraction - controlled vocabulary keeps this precise (vs. free-form
# NER, which over-triggers on resume text). Add aliases here as your skills
# table grows.
# --------------------------------------------------------------------------
SKILL_ALIASES = {
    # --- core skills (as before) ---
    "javascript": "JavaScript", "js": "JavaScript",
    "react": "React", "react.js": "React", "reactjs": "React",
    "css": "CSS", "css3": "CSS",
    "python": "Python",
    "sql": "SQL",
    "excel": "Excel", "spreadsheets": "Excel",
    "java": "Java", "spring boot": "Spring Boot",
    "c++": "C++", "cpp": "C++",
    "node.js": "Node.js", "nodejs": "Node.js", "node": "Node.js",
    "docker": "Docker", "aws": "AWS", "amazon web services": "AWS",
    "system design": "System design", "distributed systems": "System design",
    "figma": "Figma", "sketch app": "Figma",
    "prototyping": "Prototyping", "wireframing": ("Prototyping", "Wireframing"),
    "git": "Git",
    # --- one mention can add a specific skill AND its parent skill (so postings asking for either match) ---
    "django": ("Python", "Django"), "flask": ("Python", "Flask"),
    "mysql": ("SQL", "MySQL"), "postgresql": ("SQL", "PostgreSQL"), "postgres": ("SQL", "PostgreSQL"),
    "sass": ("CSS", "Sass"), "tailwind": ("CSS", "Tailwind CSS"), "tailwind css": ("CSS", "Tailwind CSS"),
    "kubernetes": ("Docker", "Kubernetes"),
    "azure": ("AWS", "Azure"), "gcp": ("AWS", "Google Cloud"), "google cloud": ("AWS", "Google Cloud"),
    "express.js": ("Node.js", "Express.js"), "expressjs": ("Node.js", "Express.js"),
    "github": ("Git", "GitHub"),
    # --- languages ---
    "typescript": "TypeScript", "php": "PHP", "kotlin": "Kotlin", "ruby": "Ruby", "scala": "Scala", "dart": "Dart",
    "rust": "Rust", "golang": "Go", "bash": "Bash", "powershell": "PowerShell", "matlab": "MATLAB", "c#": "C#",
    # --- web / backend ---
    "html": "HTML", "html5": "HTML", "vue": "Vue.js", "vue.js": "Vue.js", "vuejs": "Vue.js", "angular": "Angular",
    "next.js": "Next.js", "nextjs": "Next.js", "jquery": "jQuery", "bootstrap": "Bootstrap", "redux": "Redux",
    "fastapi": "FastAPI", "laravel": "Laravel", ".net": ".NET", "asp.net": "ASP.NET",
    "rest api": "REST APIs", "rest apis": "REST APIs", "restful": "REST APIs", "graphql": "GraphQL",
    "microservices": "Microservices", "responsive design": "Responsive Design",
    # --- mobile ---
    "flutter": "Flutter", "react native": "React Native", "firebase": "Firebase",
    "android development": "Android Development", "ios development": "iOS Development",
    # --- data / AI ---
    "mongodb": "MongoDB", "sqlite": "SQLite", "redis": "Redis", "nosql": "NoSQL",
    "pandas": "Pandas", "numpy": "NumPy", "power bi": "Power BI", "tableau": "Tableau",
    "machine learning": "Machine Learning", "deep learning": "Deep Learning", "tensorflow": "TensorFlow",
    "pytorch": "PyTorch", "scikit-learn": "Scikit-learn", "sklearn": "Scikit-learn",
    "natural language processing": "Natural Language Processing", "nlp": "Natural Language Processing",
    "computer vision": "Computer Vision", "data analysis": "Data Analysis", "data structures": "Data Structures",
    "algorithms": "Algorithms", "data visualization": "Data Visualization", "data mining": "Data Mining", "etl": "ETL",
    # --- devops / infra / security / QA ---
    "gitlab": "GitLab", "linux": "Linux", "ci/cd": "CI/CD", "jenkins": "Jenkins", "nginx": "Nginx",
    "networking": "Networking", "cybersecurity": "Cybersecurity", "penetration testing": "Penetration Testing",
    "unit testing": "Unit Testing", "software testing": "Software Testing", "quality assurance": "Quality Assurance",
    "selenium": "Selenium", "jest": "Jest", "postman": "Postman",
    # --- design ---
    "photoshop": "Adobe Photoshop", "illustrator": "Adobe Illustrator", "adobe xd": "Adobe XD", "canva": "Canva",
    "ui design": "UI Design", "ux design": "UX Design", "ui/ux": ("UI Design", "UX Design"),
    "graphic design": "Graphic Design", "video editing": "Video Editing", "premiere pro": "Adobe Premiere Pro",
    # --- office / business ---
    "microsoft word": "Microsoft Word", "powerpoint": "PowerPoint", "google workspace": "Google Workspace",
    "microsoft office": "Microsoft Office", "data entry": "Data Entry", "bookkeeping": "Bookkeeping",
    "accounting": "Accounting", "technical writing": "Technical Writing", "content writing": "Content Writing",
    "copywriting": "Copywriting", "social media": "Social Media Management", "digital marketing": "Digital Marketing",
    "seo": "SEO", "customer service": "Customer Service", "project management": "Project Management",
    "agile": "Agile", "scrum": "Scrum", "jira": "Jira", "trello": "Trello",
    # --- general ---
    "object-oriented programming": "Object-Oriented Programming", "oop": "Object-Oriented Programming",
    "version control": "Version Control", "web development": "Web Development",
    "mobile development": "Mobile Development", "game development": "Game Development",
    "arduino": "Arduino", "raspberry pi": "Raspberry Pi", "iot": "IoT",
}
# Deliberately NOT auto-detected, because the word is too common in ordinary sentences (it would create false
# skills): "go", "c", "r", "swift", "unity", "oracle", "spring", "express", "research", "leadership", ...
# Students can still add those by hand on the Profile page.


def extract_text(pdf_path: str) -> str:
    reader = PdfReader(pdf_path)
    text = "\n".join((page.extract_text() or "") for page in reader.pages)
    return text.lower()


def _targets(value):
    return (value,) if isinstance(value, str) else tuple(value)


def extract_skills(text: str):
    """Names of the skills mentioned anywhere in the resume text."""
    return sorted(extract_skill_levels(text, with_levels=False))


def estimate_level(text: str, skill: str) -> int:
    """Level for the FIRST mention of `skill` (kept for backwards compatibility; the endpoint now uses
    extract_skill_levels, which looks at every mention)."""
    idx = text.find(skill.lower())
    context = text[max(0, idx - 80): idx + 80] if idx > -1 else skill
    return _level_for_context(context)


def _level_for_context(context: str) -> int:
    if _PROF_MODEL is not None:
        return _LEVEL_MAP[_predict_proficiency(context)]
    if any(w in context for w in ["led", "senior", "advanced", "3+ years", "expert"]):
        return 85
    if any(w in context for w in ["intermediate", "familiar", "2 years", "used"]):
        return 65
    return 55


def extract_skill_levels(text: str, with_levels: bool = True):
    """{skill: level}. Every mention of every alias is classified from the ~80 characters around it, and a skill
    keeps its HIGHEST level. So "Skills: Python" (Beginner) no longer hides "Built an API with Python" further
    down (Intermediate) - the strongest evidence in the resume wins."""
    window = 80
    found = {}
    for alias, value in SKILL_ALIASES.items():
        pattern = r"(?<![a-z0-9])" + re.escape(alias) + r"(?![a-z0-9])"
        for m in re.finditer(pattern, text):
            level = _level_for_context(text[max(0, m.start() - window): m.end() + window]) if with_levels else 0
            for skill in _targets(value):
                if level > found.get(skill, -1):
                    found[skill] = level
            if not with_levels:
                break  # one hit is enough when we only need the names
    return found


class ExtractRequest(BaseModel):
    internId: str
    filePath: str


@app.post("/extract-skills")
def extract_skills_endpoint(req: ExtractRequest):
    if not os.path.exists(req.filePath):
        raise HTTPException(404, f"Resume file not found at {req.filePath}")

    text = extract_text(req.filePath)
    levels = extract_skill_levels(text)
    skills = sorted(levels)

    conn = db()
    cur = conn.cursor()
    for skill in skills:
        level = levels[skill]
        cur.execute(
            "INSERT INTO skills (name) VALUES (%s) ON DUPLICATE KEY UPDATE name = VALUES(name)",
            (skill,),
        )
        cur.execute("SELECT id FROM skills WHERE name = %s", (skill,))
        skill_id = cur.fetchone()[0]
        cur.execute(
            """INSERT INTO intern_skills (intern_id, skill_id, level, source)
               VALUES (%s, %s, %s, 'resume_parse')
               ON DUPLICATE KEY UPDATE level = GREATEST(level, VALUES(level))""",
            (req.internId, skill_id, level),
        )
    conn.commit()
    cur.close()
    conn.close()

    return {"skills": skills, "count": len(skills)}


class ScoreRequest(BaseModel):
    internId: str
    postingId: str


def compute_score(intern_skills: dict, posting_skills: dict) -> int:
    if not posting_skills:
        return 0
    matched = [name for name in posting_skills if name in intern_skills]
    if not matched:
        return 12
    coverage = len(matched) / len(posting_skills)
    weighted_strength = sum(intern_skills[n] * posting_skills[n] for n in matched)
    weighted_total = sum(100 * posting_skills[n] for n in matched)
    strength = weighted_strength / weighted_total if weighted_total else 0
    return round((coverage * 0.6 + strength * 0.4) * 100)


@app.post("/score")
def score_endpoint(req: ScoreRequest):
    conn = db()
    cur = conn.cursor(dictionary=True)
    cur.execute(
        """SELECT s.name, isk.level FROM intern_skills isk
           JOIN skills s ON s.id = isk.skill_id WHERE isk.intern_id = %s""",
        (req.internId,),
    )
    intern_skills = {r["name"]: r["level"] for r in cur.fetchall()}

    cur.execute(
        """SELECT s.name, ps.weight FROM posting_skills ps
           JOIN skills s ON s.id = ps.skill_id WHERE ps.posting_id = %s""",
        (req.postingId,),
    )
    posting_skills = {r["name"]: r["weight"] for r in cur.fetchall()}
    cur.close()
    conn.close()

    return {"score": compute_score(intern_skills, posting_skills)}


@app.get("/health")
def health():
    return {"ok": True}