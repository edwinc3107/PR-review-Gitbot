//file to read from the terminal
const command = process.argv[2];
const username = process.argv[3];
console.log(`Hello, ${username}!`);
console.log(`Command: ${command}`);

async function main() {

if (command === "events") {
    // 1. get username
    // 2. call getUserEvents(username)
    // 3. handle errors (try/catch)
    // 4. print data
    try {
        const data = await getUserEvents(username);
        console.log(data);
    } catch (error) {
        console.error(error);
    }
    console.log("done");
    process.exit(0);
    //0 means success
}
}

main();