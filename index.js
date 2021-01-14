const crypto = require('crypto');
const nodeFetch = require('node-fetch');
const fetch = require('fetch-cookie')(nodeFetch);
const sjcl = require('sjcl-all');

require('dotenv').config();

async function login() {
    let params = new URLSearchParams();
    params.append("roll", process.env.CEO_ROLL);
    params.append("pass", crypto.createHash('sha256').update(process.env.CEO_PASSWORD).digest('hex'));
    let response = await fetch(process.env.BASE_URL+"/users/login", {method: 'POST', body: params});
    if(!response.ok) return false;
    let json = await response.json();
    return json;
}

async function fetchDataFromUrl(url) {
    let response = await fetch(process.env.BASE_URL+url);
    if(!response.ok) return false;
    let json = await response.json();
    return json;
}

async function fetchElectionData() {
    let posts = await fetchDataFromUrl("/ceo/fetchPosts");
    let candidates = await fetchDataFromUrl("/ceo/fetchCandidates");
    let votes = await fetchDataFromUrl("/ceo/fetchVotes");
    return [posts, candidates, votes];
}

function getCategorizedVotesAndCandidates(fetchedPosts, fetchedCandidates, fetchedVotes) {
    let categories = {};
    fetchedPosts.forEach(post => categories[post.postId] = {votes:[], candidates:[]});
    fetchedVotes.forEach(vote => categories[vote.postId].votes.push(vote.data));
    fetchedCandidates.forEach(candidate => categories[candidate.postId].candidates.push(candidate));
    return categories;
}

function calculateResultsForPost(ceoKey, candidates, votes, hasNota) {
    candidates.forEach(candidate => {
        candidate.preference1 = 0;
        candidate.preference2 = 0;
        candidate.preference3 = 0;
        candidate.roll = candidate.roll;
        candidate.name = candidate.name;
    });
    let count = 0, progress = 0, total = votes.length, numNOTA=0;
    let strippedVotes = votes.map(vote => {
        count += 1;
        progress = 100*count/total;
        process.stdout.write("Progress: "+ progress.toFixed(3) + "%\r");
        try{
            return sjcl.decrypt(ceoKey, vote);;
        }catch{
            return "0-0-0-0";
        }
    });
    let splitVotes = strippedVotes.map(vote => vote.split("-"));
    splitVotes.forEach(vote => {
        candidates.forEach(candidate => {
            if(candidate.roll == vote[1]){
                candidate.preference1 += 1;
            }else if(candidate.roll == vote[2]){
                candidate.preference2 += 1;
            }else if(candidate.roll == vote[3]){
                candidate.preference3 += 1;
            }
        });
    });
    numNOTA = strippedVotes.filter(vote => vote.endsWith("-0-0-0")).length;
    if(hasNota) {
        candidates.push({
            preference1: numNOTA,
            preference2: 0,
            preference3: 0,
            roll: "0",
            name: "NOTA",
        });
    }
    process.stdout.write("\n");
    return [strippedVotes, candidates];
}

function calculateAllResults(ceoKey, fetchedPosts, fetchedCandidates, fetchedVotes) {
    let categorizedData = getCategorizedVotesAndCandidates(fetchedPosts, fetchedCandidates, fetchedVotes);
    let posts = fetchedPosts;
    posts.forEach(post => {
        console.log("Calculating results for the post: ", post.postName);
        let result = calculateResultsForPost(
            ceoKey,
            categorizedData[post.postId].candidates,
            categorizedData[post.postId].votes,
            post.hasNota,
        );
        post.candidates = result[1];
        post.ballotIds = result[0];
    });
    return {
        posts: posts
    };
}

async function main() {
    console.log("Logging in as the CEO...");
    let ceoData = await login();
    if(!ceoData) {
        console.log("Login failed.");
        return;
    }
    let ceoKey = new sjcl.ecc.elGamal.secretKey(sjcl.ecc.curves.c256,
        sjcl.ecc.curves.c256.field.fromBits(sjcl.codec.base64.toBits(sjcl.decrypt(process.env.CEO_PASSWORD, ceoData.privateKey)))
    );
    console.log("Login successful.");
    
    console.log("Fetching data from the server...");
    let [posts, candidates, votes] = await fetchElectionData();
    if(!posts || !candidates || !votes) {
        console.log("Failed to fetch data from the server.")
        return;
    }
    console.log("Fetched the data.");
    
    console.log("Starting result calculation.");
    let result = calculateAllResults(ceoKey, posts, candidates, votes);
    console.log("Results calculated.");
    
    console.log("Sending the results to the server...");
    let response = await fetch(process.env.BASE_URL+"/ceo/submitResults", {method: 'POST', body: JSON.stringify(result)});
    let text = await response.text();
    console.log("Results sent to the server.");
    console.log("Server's response: ", text);
}

main();
