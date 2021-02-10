const fs = require('fs');
const crypto = require('crypto');
const nodeFetch = require('node-fetch');
const fetch = require('fetch-cookie')(nodeFetch);
const sjcl = require('sjcl-all');

require('dotenv').config();

async function login() {
    let params = new URLSearchParams();
    params.append("roll", process.env.CEO_ROLL);
    params.append("pass", crypto.createHash('sha256').update(process.env.CEO_PASSWORD).digest('hex'));
    let response = await fetch(process.env.BASE_URL+"/api/users/login", {method: 'POST', body: params});
    if(!response.ok){
        console.log(await response.text());
        return false;
    }
    let json = await response.json();
    return json;
}

async function fetchDataFromUrl(url) {
    let response = await fetch(process.env.BASE_URL+url);
    if(!response.ok){
        console.log(await response.text());
        return false;
    }
    let json = await response.json();
    return json;
}

async function fetchElectionData() {
    let posts = await fetchDataFromUrl("/api/ceo/fetchPosts");
    let candidates = await fetchDataFromUrl("/api/ceo/fetchCandidates");
    let votes = await fetchDataFromUrl("/api/ceo/fetchVotes");
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
    let numCandidates = candidates.length;
    let numToBeSelected = Math.min(3, numCandidates);
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
    let unparseableVotes = 0;
    splitVotes = splitVotes.filter(vote => {
        if(vote[0]=="0"){
            unparseableVotes += 1;
            return false;
        }
        return true;
    })
    splitVotes.forEach(vote => {
        if(hasNota && vote[1]=="0" && vote[2]=="0" && vote[3]=="0") {
            return;
        }
        for(let i=1; i<=numToBeSelected; i++){
            if(vote[i]=="0") {
                console.log("Discarding invalid vote: "+ vote.join("-"));
                return;
            }
        }
        for(let i=numToBeSelected+1; i<=3; i++){
            if(vote[i]!="0") {
                console.log("Discarding invalid vote: "+ vote.join("-"));
                return;
            }
        }
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
    } else if (numNOTA > 0) {
        console.log("Found "+ numNOTA +" NOTA votes, but post doesn't allow NOTA. Discarding them.")
    }
    process.stdout.write("\n");
    if(unparseableVotes > 0) {
        console.log("Found "+ unparseableVotes +" unparseable vote(s).");
    }
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

const compareCandidates = (a, b) => {
    // if +ve => b comes before a
    // if -ve => a comes before b
    if(a.preference1 === b.preference1){
      if(a.preference2 === b.preference2)
        return b.preference3-a.preference3;
      else
        return b.preference2-a.preference2;
    }else{
      return b.preference1-a.preference1;
    }
  }

function displayResults(post) {
    let nameLen = 32;
    let prefLen = 6;
    let extra = 3*5;
    let totalLen = extra+nameLen+(prefLen*3);
    console.log("=".padEnd(totalLen, "="));
    console.log((" | Post: "+post.postName).padEnd(totalLen-3)+" | ");
    console.log("-".padEnd(totalLen, "-"));
    console.log(" | Roll - Name".padEnd(nameLen+3)+" | Pref 1 | Pref 2 | Pref 3 |");
    console.log("-".padEnd(totalLen, "-"));
    post.candidates.sort(compareCandidates).forEach(candidate => {
        let cname = (candidate.roll+" - "+candidate.name).padEnd(nameLen);
        let p1 = (""+candidate.preference1).padEnd(prefLen);
        let p2 = (""+candidate.preference2).padEnd(prefLen);
        let p3 = (""+candidate.preference3).padEnd(prefLen);
        console.log(" | "+cname+" | "+p1+" | "+p2+" | "+p3+" | ");
    });
    console.log("-".padEnd(totalLen, "-"));
    console.log("");
    console.log("");
    console.log("");
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
    console.log("");
    console.log("");
    console.log("");
    
    fs.writeFileSync('results.json', JSON.stringify(result, null, 4) , 'utf-8');
    
    result.posts.forEach(post => displayResults(post));
    
    console.log("Sending the results to the server...");
    let response = await fetch(process.env.BASE_URL+"/api/ceo/submitResults", {method: 'POST', body: JSON.stringify(result)});
    let text = await response.text();
    console.log("Results sent to the server.");
    console.log("Server's response: ", text);
}

main();
