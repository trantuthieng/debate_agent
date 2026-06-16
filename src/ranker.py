# src/ranker.py
from job_searcher import JobListing
from cv_parser import CV
from typing import List
def relevance_score(job: JobListing, cv: CV) -> float:
    skill_score = len(set(job.description.split()) & set(cv.skills)) / max(len(cv.skills), 1)
    title_match = any(skill.lower() in job.title.lower() for skill in cv.skills[:3]) * 0.5
    return min(1.0, (skill_score + title_match) / 1.5)

def rank_jobs(jobs: List[JobListing], cv: CV) -> List['JobMatch']:
    ranked_matches = []
    for job in jobs:
        score = relevance_score(job, cv)
        match = JobMatch(listing=job, relevance_score=score, matching_skills=[skill for skill in cv.skills if skill.lower() in job.description.lower()])
        ranked_matches.append(match)
    ranked_matches.sort(key=lambda x: x.relevance_score, reverse=True)
    return ranked_matches

@dataclass
class JobMatch:
    listing: JobListing
    relevance_score: float  # 0-1 scale
    matching_skills: list[str]
