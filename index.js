//file to read from the terminal
const command = process.argv[2];
const username = process.argv[3];
console.log(`Hello, ${username}!`);
console.log(`Command: ${command}`);

const args = process.argv.slice(4);
const limitArg = args.find(arg => arg.startsWith("limit="))?.split("=")[1];
const sortByArg = args.find(arg => arg.startsWith("sort="))?.split("=")[1];

const limit = limitArg ? parseInt(limitArg, 10) : null;
const sortBy = sortByArg || null;

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

async function fetchCommitMessages(commitsUrl) {
    const response = await fetch(commitsUrl, { headers: { 'Authorization': `token ${GITHUB_TOKEN}`, 'Accept': 'application/vnd.github.v3+json'}
    });

    if (!response.ok) {
        throw new Error(`Failed to fetch commits: ${response.status}`);
    }

    const commits = await response.json();
    return commits.map(commit => commit?.commit?.message.split("\n")[0]);
}

// First pass: Collect and group PR events and reviews
function collectPrEvents(events) {
    const prMap = new Map();
    
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
    
    return prMap;
}

function computeRegressionRisk(pr) {
    // Thresholds for regression risk factors
    const LARGE_DIFF_THRESHOLD = 500; // Large PR threshold
    const MANY_FILES_THRESHOLD = 10;  // Many files threshold
    
    const weights = {
        largeDiff: 0.40,
        manyFiles: 0.35,
        coreChanges: 0.50,
        noTests: 0.20,
    };
  
    const factors = []; // List of factors that contribute to regression risk

    // Calculate total lines changed
    const linesChanged = (pr.additions ?? 0) + (pr.deletions ?? 0);
    const filesChanged = pr.changed_files ?? 0;

    // Check if PR has large diff
    if (linesChanged > LARGE_DIFF_THRESHOLD) {
        factors.push(weights.largeDiff);
    }
    
    // Check if PR touches many files
    if (filesChanged > MANY_FILES_THRESHOLD) {
        factors.push(weights.manyFiles);
    }
    
    // Check if PR touches core folders (simplified - would need file paths from API)
    // For now, we'll skip this check as we don't have file paths in the current data
    // if (prMetrics.touchesCoreFolder) factors.push(weights.coreChanges);
    
    // Check if PR has test changes (simplified - would need file paths from API)
    // For now, we'll skip this check as we don't have file paths in the current data
    // if (!prMetrics.hasTestChanges) factors.push(weights.noTests);
  
    // Use the formula: 1 - Π (1 - weight_i) to calculate the score
    const product = factors.reduce((acc, w) => acc * (1 - w), 1);
    const score = 1 - product; // Score between 0 and 1
  
    // Determine the category of the regression risk
    let category;
    if (score > 0.7) {
        category = "High regression risk";
    } else if (score > 0.4) {
        category = "Medium risk";
    } else {
        category = "Low risk";
    }
  
    return { score, category };
}
  

// Second pass: Enrich PR data with API calls
async function enrichPrData(prMap) {
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
                entry.commitMessages = await fetchCommitMessages(entry.pr.commits_url);
            } catch (err) {
                console.error(`Could not fetch commits for ${repoName}#${pr.number}: ${err.message}`);
                entry.commitMessages = [];
            }
        }
    }
}

// Format a single PR entry into a summary object
function formatSinglePr(entry) {
    const { pr, repoName, reviews } = entry;
    const commitMessages = entry.commitMessages || [];
    
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
    
    // Compute impact and type
    const impact = computeImpactScore({
        additions: pr.additions,
        deletions: pr.deletions,
        changed_files: pr.changed_files,
        commit_count: commitMessages.length,
        review_count: reviews.length,
    });
    const prType = typePR(commitMessages);
    
    // Format commit messages
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
    
    const impactLine = `- Impact: ${impact.category} (score ${impact.score.toFixed(0)})`;
    const typeLine = prType ? `- PR type: ${prType}` : "";
    
    // Build reviews section
    let reviewsSection = "";
    if (reviews.length > 0) {
        reviewsSection = `- Reviews (${reviews.length}):\n`;
        reviews.forEach(review => {
            reviewsSection += `  • ${review.state} by ${review.reviewer} on ${review.date}\n`;
        });
        reviewsSection = reviewsSection.trimEnd();
    } else {
        reviewsSection = `- Reviews: (none)`;
    }

    // Compute regression risk if we have PR data
    let regressionRiskLine = "";
    if (pr.additions !== undefined && pr.deletions !== undefined) {
        const regressionRisk = computeRegressionRisk(pr);
        // Score is between 0-1, so show as percentage
        regressionRiskLine = `- Regression risk: ${regressionRisk.category} (score ${(regressionRisk.score * 100).toFixed(1)}%)`;
    }
    
    // Combine everything into formatted string
    const summaryText = [titleLine, lineChange, fileChange, impactLine, typeLine, commitSummary, reviewsSection, regressionRiskLine]
        .filter(Boolean)
        .join("\n");
    
    // Return object with data for sorting and formatted text
    return {
        pr: pr,
        impact: impact,
        reviews: reviews,
        text: summaryText
    };
}

// Sort summaries based on criteria
function sortSummaries(summaries, sortBy) {
    if (!sortBy) return summaries;
    
    summaries.sort((a, b) => {
        switch(sortBy) {
            case "lines":
                return ((b.pr.additions ?? 0) + (b.pr.deletions ?? 0)) -
                       ((a.pr.additions ?? 0) + (a.pr.deletions ?? 0));
            case "impact":
                return (b.impact?.score ?? 0) - (a.impact?.score ?? 0);
            case "reviews":
                return (b.reviews?.length ?? 0) - (a.reviews?.length ?? 0);
            default:
                return 0;
        }
    });
    
    return summaries;
}

// Main function: Orchestrates all three passes
async function formatEvents(events, sortBy = null, limit = null) {
    // First pass: Collect and group events
    const prMap = collectPrEvents(events);
    
    // Second pass: Enrich with API calls
    await enrichPrData(prMap);
    
    // Third pass: Format all PRs
    const summaries = [];
    for (const [key, entry] of prMap) {
        summaries.push(formatSinglePr(entry));
    }
    
    // Sort and limit
    sortSummaries(summaries, sortBy);
    const limitedSummaries = limit ? summaries.slice(0, limit) : summaries;
    
    // Return just the text strings
    return limitedSummaries.map(s => s.text);
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

function computeImpactScore(prMetrics) {
    const additions = prMetrics.additions ?? 0;
    const deletions = prMetrics.deletions ?? 0;
    const changedFiles = prMetrics.changed_files ?? 0;
    const commitCount = prMetrics.commit_count ?? 0;
    const reviewCount = prMetrics.review_count ?? 0;

    const score = additions * 0.5 + deletions * 0.25 + changedFiles * 10 + commitCount * 5 + reviewCount * 8;

    if (score < 200) {
        return { score, category: "Small PR" };
    } else if (score < 800) {
        return { score, category: "Medium PR" };
    }
    return { score, category: "Large / High-risk PR" };
}

function typePR(commitMessages = []) {
    // Combine all commit messages into one string and make it lowercase
    const allMessages = commitMessages.join(" ").toLowerCase();

    // Check for bug fix keywords
    if (allMessages.includes("fix") || allMessages.includes("bug") || allMessages.includes("hotfix")) {
        return "Bug Fix PR";
    }
    
    // Check for refactor keywords
    if (allMessages.includes("refactor") || allMessages.includes("cleanup")) {
        return "Refactor PR";
    }
    
    // Check for documentation keywords
    if (allMessages.includes("docs") || allMessages.includes("readme")) {
        return "Documentation PR";
    }
    
    // Check for feature keywords
    if (allMessages.includes("feat") || allMessages.includes("feature") || 
        allMessages.includes("add") || allMessages.includes("implement")) {
        return "Feature PR";
    }

    // No type detected
    return null;
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
            const lines = await formatEvents(data, sortBy, limit);
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