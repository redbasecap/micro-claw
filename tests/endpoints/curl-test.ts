import * as fs from "fs";
import * as https from "https";

const endpointUrl = "https://api.example.com/endpoint";
const options = { method: "GET", headers: { "Content-Type": "application/json" } };

https.get(endpointUrl, options, (res) => {
  let data = ``;
  res.on("data", (chunk) => {
    data += chunk;
  }).on("end", () => {
    console.log(data);
  });
}).catch((err) => {
  console.error(err);
});