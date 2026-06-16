# src/cv_parser.py
import re
from dataclasses import dataclass, field

def parse_cv(file_path):
    with open(file_path, 'r') as file:
        content = file.read()
    cv_data = {}
    sections = ['SUMMARY', 'SKILLS', 'EXPERIENCE', 'EDUCATION']
    current_section = None
    for line in content.splitlines():
        if any(section in line for section in sections):
            current_section = line.strip()
            cv_data[current_section] = []
        elif current_section:
            cv_data[current_section].append(line.strip())
    return CV(
        name=cv_data['SUMMARY'][0],
        email=re.search(r'Email: (.*?) \|', content).group(1),
        location=re.search(r'Location: (.*)', content).group(1),
        skills=cv_data['SKILLS'],
        experience=[{'title': exp.split('—')[0].strip(), 'company': exp.split('—')[1].split('(')[0].strip()} for exp in cv_data['EXPERIENCE']],
        education=[{'degree': edu.split(',')[0].strip(), 'institution': edu.split(',')[1].strip()} for edu in cv_data['EDUCATION']]
    )

@dataclass
class CV:
    name: str
    email: str | None = None
    location: str | None = None
    skills: list[str] = field(default_factory=list)
    experience: list[dict] = field(default_factory=list)  # [{'title': ..., 'company': ...}]
    education: list[dict] = field(default_factory=list)   # [{'degree': ..., 'institution': ...}]
