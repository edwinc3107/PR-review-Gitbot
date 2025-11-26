//file to read from the terminal
const command = process.argv[2];
const username = process.argv[3]; // Only used for "events" command

const args = process.argv.slice(4);




const limitArg = args.find(arg => arg.startsWith("limit="))?.split("=")[1];
const sortByArg = args.find(arg => arg.startsWith("sort="))?.split("=")[1];

const limit = limitArg ? parseInt(limitArg, 10) : null;
const sortBy = sortByArg || null;

import { getUserEvents } from "./src/github.js";
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { execSync } from 'child_process';
import { readFileSync, existsSync } from 'fs';
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

export function computeRegressionRisk(pr) {
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
    for (const [_key, entry] of prMap) {
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
    for (const [_key, entry] of prMap) {
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

export function computeImpactScore(prMetrics) {
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

export function typePR(commitMessages = []) {
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

//this is where our bot is built - using the below functions
//first, we need to create a way to add comments/post comments on the PR

async function addComments(prNumber, commentText, repoFullName) {
    // Use /issues endpoint (PRs are also issues in GitHub API)
    const url = `https://api.github.com/repos/${repoFullName}/issues/${prNumber}/comments`;

    const response = await fetch(url, {
        method: "POST",
        headers: {
            'Authorization': `token ${GITHUB_TOKEN}`,
            'Content-Type': 'application/json',
            'Accept': 'application/vnd.github.v3+json'
        },
        body: JSON.stringify({ body: commentText })
    }); 

    //CHECK FOR ERRORS
    if(!response.ok){
        throw new Error(`Failed to add comments: ${response.status}`);
    }
    const data = await response.json();
    console.log(data);  //this is the data that was returned from the API
    //if we reach this point, the comments were added successfully
    console.log(`Comments added successfully for PR #${prNumber}`);
    return true;
}

//this function is used to get the reviews for a given PR
//Returns: Array of review objects
//similar to getFullPr, but for reviews
async function getPrReviews(repoFullName, prNumber){
    // repoFullName is already in "owner/repo" format
    const url = `https://api.github.com/repos/${repoFullName}/pulls/${prNumber}/reviews`;

    const response = await fetch(url, {
        headers:{
            'Authorization': `token ${GITHUB_TOKEN}`,
        },
        method: "GET",
        'Content-Type': 'application/json',
    });
    
    if(!response.ok){
        throw new Error(`Failed to get PR reviews: ${response.status}`);
    }
    const data = await response.json();
    return data;
}

// Get list of files changed in the PR
async function getPrFiles(repoFullName, prNumber) {
    const url = `https://api.github.com/repos/${repoFullName}/pulls/${prNumber}/files`;
    
    const response = await fetch(url, {
        headers: {
            'Authorization': `token ${GITHUB_TOKEN}`,
            'Accept': 'application/vnd.github.v3+json'
        }
    });
    
    if (!response.ok) {
        throw new Error(`Failed to get PR files: ${response.status}`);
    }
    
    const files = await response.json();
    // Return only JavaScript/TypeScript files that need linting
    return files
        .filter(file => file.filename.endsWith('.js') || file.filename.endsWith('.ts') || file.filename.endsWith('.jsx') || file.filename.endsWith('.tsx'))
        .map(file => file.filename);
}

// Run linting on specific files
function runLinting(files) {
    if (files.length === 0) {
        return { success: true, output: "No JavaScript/TypeScript files to lint", errors: [] };
    }
    
    try {
        // Run eslint on the specific files
        const filesStr = files.join(' '); //create a string of the files
        const output = execSync(`npx eslint ${filesStr}`, {  encoding: 'utf-8', stdio: 'pipe' }); //run the linting on the files
        return { success: true, output: output || "No linting errors", errors: [] };
    } catch (error) {
        // ESLint exits with code 1 if there are errors, but we want the output
        const errors = error.stdout || error.stderr || error.message;
        return { success: false, output: errors, errors: errors.split('\n').filter(line => line.trim().length > 0) };
    }
}

// This function converts PR analysis into a markdown comment for GitHub
function formatReviewComment(pr, reviews, commitMessages, lintResults = null, coverageResults = null) {
    // Compute all the analysis metrics
    const impact = computeImpactScore({
        additions: pr.additions ?? 0,
        deletions: pr.deletions ?? 0,
        changed_files: pr.changed_files ?? 0,
        commit_count: commitMessages.length,
        review_count: reviews.length,
    });
    
    const prType = typePR(commitMessages);
    const regressionRisk = computeRegressionRisk(pr);
    
    // Build markdown comment
    let comment = `## Automated PR Review\n\n`;
    
    // PR Title
    comment += `### PR Details\n\n`;
    comment += `**Title:** ${pr.title || "(no title)"}\n`;
    comment += `**Number:** #${pr.number}\n\n`;
    
    // Changes summary
    comment += `### Changes Summary\n\n`;
    if (pr.additions !== undefined && pr.deletions !== undefined) {
        comment += `- **Lines changed:** +${pr.additions} / -${pr.deletions}\n`;
    }
    if (pr.changed_files !== undefined) {
        comment += `- **Files changed:** ${pr.changed_files}\n`;
    }
    comment += `\n`;
    
    // Analysis metrics
    comment += `### Analysis\n\n`;
    comment += `- **Impact:** ${impact.category} (score: ${impact.score.toFixed(0)})\n`;
    if (prType) {
        comment += `- **PR Type:** ${prType}\n`;
    }
    comment += `- **Regression Risk:** ${regressionRisk.category} (${(regressionRisk.score * 100).toFixed(1)}%)\n`;
    comment += `\n`;
    
    // Commit messages
    if (commitMessages.length > 0) {
        comment += `### Commits (${commitMessages.length})\n\n`;
        commitMessages.forEach((message, index) => {
            comment += `${index + 1}. ${message}\n`;
        });
        comment += `\n`;
    }
    
    // Reviews
    if (reviews && reviews.length > 0) {
        comment += `### Reviews (${reviews.length})\n\n`;
        reviews.forEach(review => {
            const state = review.state || "unknown";
            const reviewer = review.user?.login || "unknown";
            const date = review.submitted_at ? new Date(review.submitted_at).toLocaleDateString() : "unknown date";
            comment += `- **${state}** by @${reviewer} on ${date}\n`;
        });
        comment += `\n`;
    }
    
    // Code Quality section
    if (lintResults || coverageResults) {
        comment += `### Code Quality\n\n`;
        
        // Linting results
        if (lintResults) {
            if (lintResults.success) {
                comment += `**Linting:** Passed\n`;
            } else {
                comment += `**Linting:** Failed\n\n`;
                comment += `<details>\n<summary>Click to see linting errors</summary>\n\n`;
                comment += `\`\`\`\n${lintResults.output}\n\`\`\`\n`;
                comment += `</details>\n\n`;
            }
        }
        
        // Test Coverage results
        if (coverageResults) {
            if (coverageResults.success) {
                if (coverageResults.lines > 0) {
                    comment += `**Test Coverage:** ${coverageResults.lines.toFixed(1)}%\n`;
                    comment += `   - Lines: ${coverageResults.lines.toFixed(1)}%\n`;
                    comment += `   - Statements: ${coverageResults.statements.toFixed(1)}%\n`;
                    comment += `   - Functions: ${coverageResults.functions.toFixed(1)}%\n`;
                    comment += `   - Branches: ${coverageResults.branches.toFixed(1)}%\n`;
                } else {
                    comment += `**Test Coverage:** No tests found\n`;
                }
            } else {
                comment += `**Test Coverage:** Failed\n\n`;
                comment += `<details>\n<summary>Click to see test errors</summary>\n\n`;
                comment += `\`\`\`\n${coverageResults.output}\n\`\`\`\n`;
                comment += `</details>\n\n`;
            }
        }
        comment += `\n`;
    }
    
    comment += `---\n*This review was automatically generated by the PR Review Bot*`;
    
    return comment;
}
//this function is used to test coverage of the code

// Run tests and get coverage
function runTestCoverage() {
    try {
        // Run jest with coverage (passWithNoTests so it doesn't fail if no tests exist)
        const output = execSync('npm run test:coverage -- --passWithNoTests', { encoding: 'utf-8', stdio: 'pipe'});
        
        // Try to read coverage summary
        const coveragePath = join(__dirname, 'coverage', 'coverage-summary.json');
        
        if (existsSync(coveragePath)) {
            //get file data from the coverage summary
            const coverageData = JSON.parse(readFileSync(coveragePath, 'utf-8'));
            
            //get the coverage data from the coverage summary
            // Handle "Unknown" values when no tests exist
            const parseCoverage = (value) => {
                if (value === "Unknown" || value === undefined) return 0;
                return typeof value === "number" ? value : parseFloat(value) || 0;
            };
            
            const linesCoverage = parseCoverage(coverageData.total?.lines?.pct);
            const statementsCoverage = parseCoverage(coverageData.total?.statements?.pct);
            const functionsCoverage = parseCoverage(coverageData.total?.functions?.pct);
            const branchesCoverage = parseCoverage(coverageData.total?.branches?.pct);
            
            return {
                success: true,
                lines: linesCoverage,
                statements: statementsCoverage,
                functions: functionsCoverage,
                branches: branchesCoverage,
                output: output
            };
        }
        
        // If no coverage file, tests passed but no coverage data
        return {
            success: true,
            lines: 0,
            statements: 0,
            functions: 0,
            branches: 0,
            output: "Tests passed (no coverage data available - no tests found)"
        };
    } catch (error) {
        // Tests failed or coverage check failed
        const errorOutput = error.stdout || error.stderr || error.message;
        return {
            success: false,
            lines: 0,
            statements: 0,
            functions: 0,
            branches: 0,
            output: errorOutput
        };
    }
}

function failJob(message) {
    console.error(message);
    process.exit(1);
}

const REQUIRED_TEMPLATE_FIELDS = [
    "## Description",
];

function enforcePrTemplate(prBody = "") {
    const normalizedBody = typeof prBody === "string" ? prBody : "";
    const missing = REQUIRED_TEMPLATE_FIELDS.filter(token => !normalizedBody.includes(token));
    return { ok: missing.length === 0, missing };
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
    else if (command === "review") {
        // Start loading indicator
        //Fetch PR → Fetch reviews → Fetch commits → Analyze → Format → Post
        //1. Fetch PR data          
        const prNumber = process.argv[3];
        const repoFullName = process.env.GITHUB_REPOSITORY;
        const token = process.env.GITHUB_TOKEN;


        if (!prNumber) {
            failJob("Missing PR number. Usage: node index.js review <pr-number>");
        }
        if (!repoFullName || !repoFullName.includes("/")) {
            failJob("GITHUB_REPOSITORY is missing or malformed (expected owner/repo).");
        }
        if (!token) {
            failJob("GITHUB_TOKEN not set. In Actions add env: GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}");
        }
        const loading = showLoading("Fetching PR data");
        let prData;
        try {
            prData = await getFullPr(prNumber, repoFullName);
            const templateCheck = enforcePrTemplate(prData.body);
            if (!templateCheck.ok) {
                const message = [
                    "PR template incomplete. Please fill out the missing sections before rerunning checks.",
                    "Missing:",
                    ...templateCheck.missing.map(item => `- ${item}`)
                  ].join("\n");
                
                  await addComments(prNumber, ` ${message}`, repoFullName)
                    .catch(err => console.error("Failed to post template warning:", err.message));
                
                  failJob("Stopped early: PR template not filled out.");
            }
            console.log("PR template is valid");
            loading.stop();
        }
        catch (error) {
            loading.stop();
            console.error(error.message);
            process.exit(1);
        }   
        
        //2. Fetch reviews
        const reviewsLoading = showLoading("Fetching PR reviews");
        let reviews;
        try {
            reviews = await getPrReviews(repoFullName, prNumber);
            reviewsLoading.stop();
        } catch (error) {
            reviewsLoading.stop();
            console.error(`Failed to fetch reviews: ${error.message}`);
            reviews = []; // Continue with empty reviews if fetch fails
        }
        
        //3. Fetch commits - use prData.commits_url
        const commitsLoading = showLoading("Fetching commits");
        let commitMessages;
        try {
            commitMessages = await fetchCommitMessages(prData.commits_url);
            commitsLoading.stop();
        } catch (error) {
            commitsLoading.stop();
            console.error(`Failed to fetch commits: ${error.message}`);
            commitMessages = []; // Continue with empty commits if fetch fails
        }
        
        //4. Get PR files and run linting
        const lintingLoading = showLoading("Running linting checks");
        let lintResults = null;
        try {
            const prFiles = await getPrFiles(repoFullName, prNumber);
            lintResults = runLinting(prFiles);
            lintingLoading.stop();
        } catch (error) {
            lintingLoading.stop();
            console.error(`Failed to run linting: ${error.message}`);
            // Continue without linting results
        }
        
        //5. Run test coverage
        const coverageLoading = showLoading("Running test coverage");
        let coverageResults = null;
        try {
            coverageResults = runTestCoverage();
            coverageLoading.stop();
        } catch (error) {
            coverageLoading.stop();
            console.error(`Failed to run test coverage: ${error.message}`);
            // Continue without coverage results
        }
        //6. Format comment (analysis is done inside formatReviewComment)
        const formattingLoading = showLoading("Formatting review comment");
        const formattedComment = formatReviewComment(prData, reviews, commitMessages, lintResults, coverageResults);
        formattingLoading.stop();
        
        //7. Post comment
        const postingLoading = showLoading("Posting comment to PR");
        let posted;
        try {
            posted = await addComments(prNumber, formattedComment, repoFullName);
            postingLoading.stop();
            if (posted) {
                console.log("Comment posted successfully to PR #" + prNumber);
            } else {
                console.error("Failed to post comment");
            }
    } catch (error) {
            postingLoading.stop();
            console.error(`Failed to post comment: ${error.message}`);
            process.exit(1);
    }
        
    console.log("done");
    process.exit(0);
    }
    else {
        console.error("Invalid command. Use 'events' or 'review'");
        process.exit(1);
    }
}

// Only run main() if this file is executed directly (not imported)
// Check if running as script (not imported by Jest)
const isMainModule = process.argv[1] && 
    (process.argv[1].endsWith('index.js') || 
     process.argv[1].endsWith('index') ||
     import.meta.url.endsWith(process.argv[1]));

if (isMainModule && command) {
main();
}


//To test the automation:
//I've created a test branch - making these comments as commits on the test branch
//Then, I've created a PR from the test branch to the main branch
//The bot should automatically review the PR and post a comment