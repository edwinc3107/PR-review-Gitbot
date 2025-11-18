//file to read from the terminal
const command = process.argv[2];
const username = process.argv[3];
console.log(`Hello, ${username}!`);
console.log(`Command: ${command}`);

import { getUserEvents } from "./src/github.js";

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

function formatEvents(events) {
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

    // Second pass: format each unique PR with its reviews
    const summaries = [];
    
    for (const [key, { pr, repoName, reviews }] of prMap) {
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
        
        const commitSummary = `- Commit messages: (not implemented yet)`;
        
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
            const lines = formatEvents(data);
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