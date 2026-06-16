# src/main.py
import argparse
from cv_parser import parse_cv
from job_searcher import search_jobs, JobListing
from ranker import relevance_score, JobMatch

def main(cv_path):
    try:
        cv = parse_cv(cv_path)
        jobs = search_jobs(cv.skills)
        ranked_matches = []
        for job in jobs:
            score = relevance_score(job, cv)
            match = JobMatch(listing=job, relevance_score=score, matching_skills=[skill for skill in cv.skills if skill.lower() in job.description.lower()])
            ranked_matches.append(match)
        ranked_matches.sort(key=lambda x: x.relevance_score, reverse=True)
        for i, match in enumerate(ranked_matches[:10]):
            print(f"{i+1}. {match.listing.title} at {match.listing.company} ({match.listing.url}) - Relevance Score: {match.relevance_score:.2f}")
    except FileNotFoundError:
        print(f"Error: The file '{cv_path}' was not found.")
    except Exception as e:
        print(f"An error occurred: {e}")

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description='Job Application Agent')
    parser.add_argument('--cv', required=True, help='path to CV/resume file')
    args = parser.parse_args()
    main(args.cv)
