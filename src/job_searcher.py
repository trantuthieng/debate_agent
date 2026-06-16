# src/job_searcher.py
from dataclasses import dataclass, field
from typing import Literal

def search_jobs(skills):
    # Placeholder for job searching logic
    return [
        JobListing(title='Senior Backend Engineer', company='Acme Corp', url='https://example.com/job1'),
        JobListing(title='Software Engineer', company='Globex', url='https://example.com/job2')
    ]

@dataclass
class JobListing:
    title: str
    company: str
    url: str
    description: str | None = None
    posted_date: str | None = None
    source: Literal['indeed', 'linkedin']  # type hint for source
