// The approved list of skills a student may type in by hand. This is what stops junk like "asdfgh" from
// reaching the skills table. To allow another skill, just add it here. Skills that companies have already
// put on a posting are accepted too (see getCatalog), so students can always match what companies ask for.
const pool = require('../db/pool');

const BASE = [
  // languages
  'JavaScript', 'TypeScript', 'Python', 'Java', 'C', 'C++', 'C#', 'PHP', 'Go', 'Rust', 'Kotlin', 'Swift', 'Dart', 'Ruby', 'R', 'MATLAB', 'Scala', 'Bash', 'PowerShell', 'Assembly', 'Lua',
  // web / frontend
  'HTML', 'CSS', 'Sass', 'React', 'Vue.js', 'Angular', 'Next.js', 'Nuxt.js', 'Svelte', 'jQuery', 'Bootstrap', 'Tailwind CSS', 'Redux', 'Responsive Design', 'Web Accessibility',
  // backend / frameworks
  'Node.js', 'Express.js', 'Django', 'Flask', 'FastAPI', 'Spring Boot', 'Laravel', '.NET', 'ASP.NET', 'Ruby on Rails', 'REST APIs', 'GraphQL', 'WebSockets', 'Microservices',
  // mobile
  'Flutter', 'React Native', 'Android Development', 'iOS Development', 'Firebase',
  // data / AI
  'SQL', 'MySQL', 'PostgreSQL', 'MongoDB', 'SQLite', 'Oracle', 'Redis', 'NoSQL', 'Data Analysis', 'Data Structures', 'Algorithms', 'Data Visualization', 'Pandas', 'NumPy', 'Power BI', 'Tableau',
  'Machine Learning', 'Deep Learning', 'TensorFlow', 'PyTorch', 'Scikit-learn', 'Natural Language Processing', 'Computer Vision', 'Data Mining', 'Statistics', 'ETL',
  // devops / cloud / infra
  'Git', 'GitHub', 'GitLab', 'Docker', 'Kubernetes', 'Linux', 'AWS', 'Azure', 'Google Cloud', 'CI/CD', 'Jenkins', 'Nginx', 'Networking', 'Cisco', 'Virtualization', 'Cloud Computing',
  // security / QA
  'Cybersecurity', 'Penetration Testing', 'Network Security', 'Cryptography', 'Software Testing', 'Quality Assurance', 'Unit Testing', 'Selenium', 'Jest', 'Postman',
  // design
  'Figma', 'Adobe Photoshop', 'Adobe Illustrator', 'Adobe XD', 'Canva', 'UI Design', 'UX Design', 'UX Research', 'Wireframing', 'Prototyping', 'Graphic Design', 'Video Editing', 'Adobe Premiere Pro', 'Animation',
  // office / business
  'Excel', 'Microsoft Word', 'PowerPoint', 'Google Workspace', 'Microsoft Office', 'Data Entry', 'Bookkeeping', 'Accounting', 'Technical Writing', 'Content Writing', 'Copywriting', 'Social Media Management', 'Digital Marketing', 'SEO', 'Email Marketing', 'Customer Service', 'Project Management', 'Agile', 'Scrum', 'Jira', 'Trello', 'Business Analysis', 'Market Research',
  // IT support / systems
  'Technical Support', 'Troubleshooting', 'Hardware Maintenance', 'System Administration', 'Database Administration', 'IT Support', 'Object-Oriented Programming', 'Software Development', 'System Design', 'Version Control', 'API Development', 'Web Development', 'Mobile Development', 'Game Development', 'Unity', 'Arduino', 'Raspberry Pi', 'IoT',
  // soft skills
  'Communication', 'Teamwork', 'Leadership', 'Problem Solving', 'Critical Thinking', 'Time Management', 'Public Speaking', 'Research', 'Presentation Skills', 'Adaptability', 'Creativity', 'Attention to Detail',
];

/** Approved list + any skill a company has already requested on a posting. Returns an array of display names. */
async function getCatalog() {
  let fromPostings = [];
  try {
    const [rows] = await pool.query('SELECT DISTINCT s.name FROM posting_skills ps JOIN skills s ON s.id = ps.skill_id');
    fromPostings = rows.map((r) => r.name);
  } catch { /* table missing? just use the base list */ }
  const seen = new Map();
  for (const n of [...BASE, ...fromPostings]) if (n && !seen.has(n.toLowerCase())) seen.set(n.toLowerCase(), n);
  return [...seen.values()].sort((a, b) => a.localeCompare(b));
}

/** Returns the approved spelling of `name` (e.g. "node.JS" -> "Node.js"), or null if it isn't on the list. */
function canonical(name, catalog) {
  const key = String(name).trim().toLowerCase();
  return catalog.find((c) => c.toLowerCase() === key) || null;
}

module.exports = { getCatalog, canonical };
