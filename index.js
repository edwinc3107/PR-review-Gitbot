//file to read from the terminal
const command = process.argv[2];
const username = process.argv[3];
console.log(`Hello, ${username}!`);
console.log(`Command: ${command}`);

import { getUserEvents } from "./src/github.js";
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

dotenv.config({ path: join(__dirname, '.env') });

const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
if (!GITHUB_TOKEN) {
    console.error("GITHUB_TOKEN is not set");
    process.exit(1);
}

function summarizePR(pr) {
    // 1. Build title line
    const prNumber = pr.number ? `PR #${pr.number}` : "PR";
    const title = pr.title || "(no title)";
    const titleLine = `${prNumber}: "${title}"`;
    
    // 2. Build line changes line (only if data is available)
    let lineChange = "";
    if (pr.additions !== undefined && pr.deletions !== undefined) {
        lineChange = `- Lines changed: +${pr.additions} / -${pr.deletions}`;
    } else {
        lineChange = `- Lines changed: (data not available in event)`;
    }
    
    // 3. Build file changes line
    let fileChange = "";
    if (pr.changed_files !== undefined) {
        fileChange = `- Files changed: ${pr.changed_files}`;
    } else {
        fileChange = `- Files changed: (data not available in event)`;
    }
    
    // 4. Commit summary (we will fill this in later)
    const commitSummary = `- Commit messages: (not implemented yet)`;
    
    // 5. Combine all
    const result = `${titleLine}\n${lineChange}\n${fileChange}\n${commitSummary}`;
    return result;
}

async function fetchCommitMessages(commitsUrl) {
    const response = await fetch(commitsUrl, { headers: { 'Authorization': `token ${GITHUB_TOKEN}`, 'Accept': 'application/vnd.github.v3+json'}
    });

    if (!response.ok) {
        throw new Error(`Failed to fetch commits: ${response.status}`);
    }

    const commits = await response.json();
    return commits.map(commit => commit?.commit?.message.split("\n")[0]);
}

async function formatEvents(events) {
    //value = { pr, reviews: [] }
    const prMap = new Map();

    // First pass: collect all PR events and reviews
    events.forEach(event => {
        const { type, payload, repo, created_at } = event;
        if (!repo) return;
        const repoName = repo.name;
        const date = new Date(created_at).toLocaleDateString();

        // PULL REQUEST EVENT - store full PR data
        if (type === "PullRequestEvent") {
            const pr = payload.pull_request;
            if (!pr || !pr.number) return;

            const key = `${repoName}#${pr.number}`;
            
            // If PR already exists, merge data (prefer more complete data)
            if (prMap.has(key)) {
                const existing = prMap.get(key);
                // Update PR data if current one has more complete info
                if (!existing.pr.additions && pr.additions) {
                    existing.pr = pr;
                }
            } else {
                prMap.set(key, {
                    pr: pr,
                    repoName: repoName,
                    reviews: []
                });
            }
            
            return;
        }

        // PR REVIEW EVENT - attach review to its PR
        if (type === "PullRequestReviewEvent") {
            const review = payload.review;
            if (!review) return;

            const pr = payload.pull_request;
            if (!pr || !pr.number) return;

            const key = `${repoName}#${pr.number}`;

            // Create PR entry if it doesn't exist (from review data)
            if (!prMap.has(key)) {
                prMap.set(key, {
                    pr: pr, // May be incomplete, but better than nothing
                    repoName: repoName,
                    reviews: []
                });
            }

            // Add review to the PR's review list
            const prEntry = prMap.get(key);
            prEntry.reviews.push({
                state: review.state || "unknown",
                reviewer: review.user?.login || "unknown",
                date: date
            });
        }
    }); 

    // Second pass: fetch full PR data if missing additions/deletions/changed_files
    for (const [key, entry] of prMap) {
        const pr = entry.pr;
        const repoName = entry.repoName;

        // Check if PR data is incomplete
        if (pr.additions === undefined || pr.deletions === undefined || pr.changed_files === undefined) {
            try {
                const fullPr = await getFullPr(pr.number, repoName);
                // Merge full PR data, keeping existing fields that might be present
                entry.pr = { ...pr, ...fullPr };
            } catch (err) {
                console.error(`Could not fetch full PR data for ${repoName}#${pr.number}: ${err.message}`);
                // Continue with partial data if fetch fails
            }
        }

        // Fetch commits (only once per PR)
        if (!entry.commitMessages && entry.pr?.commits_url) {
            try {
                entry.commitMessages = await fetchCommitMessages(entry.pr.commits_url); //fetch url of commits
            } catch (err) {
                console.error(`Could not fetch commits for ${repoName}#${pr.number}: ${err.message}`);
                entry.commitMessages = [];
            }
        }
    }

    // Third pass: format each unique PR with its reviews
    const summaries = [];
    
    for (const [key, entry] of prMap) {
        const { pr, repoName, reviews } = entry;
        // Build PR summary
        const prNumber = pr.number ? `PR #${pr.number}` : "PR";
        const title = pr.title || "(no title)";
        const titleLine = `${prNumber}: "${title}" (${repoName})`;
        
        // PR details
        let lineChange = "";
        if (pr.additions !== undefined && pr.deletions !== undefined) {
            lineChange = `- Lines changed: +${pr.additions} / -${pr.deletions}`;
        } else {
            lineChange = `- Lines changed: (data not available in event)`;
        }
        
        let fileChange = "";
        if (pr.changed_files !== undefined) {
            fileChange = `- Files changed: ${pr.changed_files}`;
        } else {
            fileChange = `- Files changed: (data not available in event)`;
        }
        
        const commitMessages = entry.commitMessages || [];
        
        let commitSummary = "";
        if (commitMessages.length > 0) {
            commitSummary = `- Commit messages (${commitMessages.length}):\n`;
            commitMessages.forEach(message => {
                commitSummary += `  • ${message}\n`;
            });
            commitSummary = commitSummary.trimEnd();
        } else {
            commitSummary = `- Commit messages: (none retrieved)`;
        }
        
        // Build reviews section
        let reviewsSection = "";
        if (reviews.length > 0) {
            reviewsSection = `- Reviews (${reviews.length}):\n`;
            reviews.forEach(review => {
                reviewsSection += `  • ${review.state} by ${review.reviewer} on ${review.date}\n`;
            });
            // Remove trailing newline
            reviewsSection = reviewsSection.trimEnd();
        } else {
            reviewsSection = `- Reviews: (none)`;
        }
        
        // Combine everything
        const summary = `${titleLine}\n${lineChange}\n${fileChange}\n${commitSummary}\n${reviewsSection}`;
        summaries.push(summary);
    }

    return summaries;
}

// Simple loading spinner
function showLoading(message = "Loading") {
    const spinner = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
    let i = 0;
    
    const interval = setInterval(() => {
        process.stdout.write(`\r${spinner[i % spinner.length]} ${message}...`);
        i++;
    }, 100);
    
    return {
        stop: () => {
            clearInterval(interval);
            // Clear the loading line
            process.stdout.write('\r' + ' '.repeat(50) + '\r');
        }
    };
}

async function getFullPr(prNumber, repoFullName) {
    const url = `https://api.github.com/repos/${repoFullName}/pulls/${prNumber}`;
    const response = await fetch(url, {
        headers: {
            'Authorization': `token ${GITHUB_TOKEN}`,
            'Accept': 'application/vnd.github.v3+json'
        }
    });
    if (!response.ok) {
        throw new Error(`Failed to fetch PR #${prNumber} from ${repoFullName}: ${response.status}`);
    }
    const data = await response.json();
    return data;
}

async function main() {
    if (command === "events") {
        // Start loading indicator
        const loading = showLoading("Fetching events");
        
        try {
            const data = await getUserEvents(username);
            
            // Stop loading and process data
            loading.stop();
            
            if (!data || data.length === 0) {
                console.log("No events found for this user.");
                return;
            }
            
            // Show processing message
            const processing = showLoading("Processing events");
            const lines = await formatEvents(data);
            processing.stop();
            
            if (lines.length === 0) {
                console.log("No matching events found (events may be of types not handled).");
            } else {
                // Join with double newline for better readability
                console.log(lines.join("\n\n"));
            }
        } catch (error) {
            loading.stop();
            console.error(error.message);
        }

        //printing the PR events
        console.log("done");
        process.exit(0);
    }
}
main();