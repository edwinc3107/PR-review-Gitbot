export async function testGithub() {
    const response = await fetch("https://api.github.com/users/octocat");
    const data = await response.json();
    console.log(data);
}

export async function getUserEvents(username) {
    // 1. build the API URL
    // 2. make the request with fetch()
    // 3. if response.status === 404 → user not found
    // 4. if 403 → rate limited
    // 5. return the parsed JSON
    const url = `https://api.github.com/users/${username}/events`;
    const response = await fetch(url);

    //error handling
    if (!response.ok) {
        if(response.status == 404){
            throw new Error(`User ${username} not found`);
        } else if(response.status == 403){
            throw new Error("Rate limited");
        } else {
            throw new Error(`Error: ${response.status} ${response.statusText}`);
        }
    }

    //if we reach this point, the response is ok
    const data = await response.json(); //what does this do?
    return data;
  }

  


