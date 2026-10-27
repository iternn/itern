// Shared match scoring — used by the student Dashboard and Matches pages so the
// "Recommended for you" numbers always agree with the Matches page.
export function scoreMatch(internSkills, postingSkills) {
  if (!postingSkills.length) return 0;
  const have = new Map(internSkills.map(s => [s.name.toLowerCase(), s.level]));
  const matched = postingSkills.filter(s => have.has(s.toLowerCase()));
  if (!matched.length) return 12; // same floor as the ML service (ml/skill_matcher.py)
  const coverage = matched.length / postingSkills.length;
  const strength = matched.length
    ? matched.reduce((sum, s) => sum + have.get(s.toLowerCase()), 0) / (matched.length * 100)
    : 0;
  return Math.round((coverage * 0.6 + strength * 0.4) * 100);
}

export function rankPostings(me, postings) {
  return postings
    .map(p => ({ ...p, skillNames: (p.skills || '').split(',').filter(Boolean) }))
    .map(p => ({ ...p, _score: scoreMatch(me.skills, p.skillNames) }))
    .sort((a, b) => b._score - a._score);
}
