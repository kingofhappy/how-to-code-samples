/*
* Copyright (c) 2015-2016 Intel Corporation.
*
* Permission is hereby granted, free of charge, to any person ("User") obtaining
* a copy of this software and associated documentation files (the
* "Software"), to deal in the Software without restriction, including
* without limitation the rights to use, copy, modify, merge, publish,
* distribute, sublicense, and/or sell copies of the Software, and to
* permit persons to whom the Software is furnished to do so, subject to
* the following conditions:
*
* The above copyright notice and this permission notice shall be
* included in all copies or substantial portions of the Software.
*
* User understands, acknowledges, and agrees that: (i) the Software is sample software;
* (ii) the Software is not designed or intended for use in any medical, life-saving
* or life-sustaining systems, transportation systems, nuclear systems, or for any
* other mission-critical application in which the failure of the system could lead to
* critical injury or death; (iii) the Software may not be fully tested and may contain
* bugs or errors; (iv) the Software is not intended or suitable for commercial release;
* (v) no regulatory approvals for the Software have been obtained, and therefore Software
* may not be certified for use in certain countries or environments.
*
* THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND,
* EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
* MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND
* NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE
* LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION
* OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION
* WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
*/

"use strict";

// The program is using the Node.js built-in `fs` module
// to load the config.json and any other files needed
var fs = require("fs");

// The program is using the Node.js built-in `path` module to find
// the file path to needed files on disk
var path = require("path");

// Load configuration data from `config.json` file. Edit this file
// to change to correct values for your configuration
var config = JSON.parse(
  fs.readFileSync(path.join(__dirname, "config.json"))
);

var datastore = require("./datastore");
var mqtt = require("./mqtt");

// The program is using the `later` module
// to handle scheduling of recurring tasks
var later = require("later");

// The program is using the `twilio` module
// to make the remote calls to Twilio service
// to send SMS alerts
var twilio;
var smsSent = false;
if (config.TWILIO_ACCT_SID && config.TWILIO_AUTH_TOKEN) {
    twilio = require("twilio")(config.TWILIO_ACCT_SID,
                               config.TWILIO_AUTH_TOKEN);
}

// Used to store the schedule for tracking when the lighting
// system should be on/off, as well as store moisture data
var SCHEDULE = {},
    MOISTURE = [],
    intervals = [];

// Initialize the hardware devices
var light = new (require("jsupm_grove").GroveLight)(0),
    moisture = new (require("jsupm_grovemoisture").GroveMoisture)(1),
    screen = new (require("jsupm_i2clcd").Jhd1313m1)(6, 0x3E, 0x62);

// Displays a message on the RGB LED
function message(string, line) {
  // pad string to avoid display issues
  while (string.length < 16) { string += " "; }

  screen.setCursor(line || 0, 0);
  screen.write(string);
}

// Set up 0-23 hour schedules
for (var i = 0; i < 24; i++) {
  SCHEDULE[i] = { on: false, off: false };
}

// Helper function to convert a value to an integer
function toInt(h) { return +h; }

// Store record in the remote datastore/mqtt server when lighting or moisture
// event has occurred
function log(event) {
  console.log(event);
  message(event);

  var payload = { value: event + " " + new Date().toISOString() };
  datastore.log(config, payload);
  mqtt.log(config, payload);
}

// Generates a later schedule for when the lights should be turned on
function onSchedule() {
  function isOn(h) { return SCHEDULE[h].on; }

  return {
    schedules: [ { h: Object.keys(SCHEDULE).filter(isOn).map(toInt) } ]
  };
}

// Generates a later schedule for when the lights should be turned off
function offSchedule() {
  function isOff(h) { return SCHEDULE[h].off; }

  return {
    schedules: [ { h: Object.keys(SCHEDULE).filter(isOff).map(toInt) } ]
  };
}

// send a text indicating something's wrong
function alert() {
  message("Lighting alert");

  if (!config.TWILIO_ACCT_SID || !config.TWILIO_AUTH_TOKEN) {
    return;
  }

  // only send SMS every 1 minute
  if (smsSent) {
    return;
  }

  var opts = { to: config.NUMBER_TO_SEND_TO,
               from: config.TWILIO_OUTGOING_NUMBER,
               body: "Lighting alert" };

  twilio.sendMessage(opts, function(err, response) {
    if (err) { return console.error("err:", err); }
    console.log("SMS sent", response);
  });

  smsSent = true;
  setTimeout(function() {
    smsSent = false;
  }, 1000 * 60);
}

// Are the lights on?
function checkLightsOn() {
  if (light.value() < 2) { alert(); }
}

// Are the lights off?
function checkLightsOff() {
  if (light.value() > 4) { alert(); }
}

// Turns on the lights
function turnOn() {
  log("on");
  setTimeout(checkLightsOn, 1000);
}

// Turns off the lights
function turnOff() {
  log("off");
  setTimeout(checkLightsOff, 1000);
}

// Updates the lighting schedule, called by web page.
function updateSchedule(data) {
  SCHEDULE = data;
  intervals.forEach(function(interval) { interval.clear(); });
  intervals = [
    later.setInterval(turnOn, onSchedule()),
    later.setInterval(turnOff, offSchedule())
  ];
}

// Starts the built-in web server for the web page
// used to set the lighting system schedule
function server() {
  var app = require("express")();

  // Helper function to generate the web page's data table
  function elem(data) {
    return [
      "<tr>",
      "<td>",
      data.time,
      "</td>",
      "<td>",
      data.value,
      "</td>",
      "</tr>"
    ].join("\n");
  }

  // Serve up the main web page used to configure lighting times
  function index(req, res) {
    function serve(err, data) {
      if (err) { return console.error(err); }
      res.send(data.replace("$MOISTUREDATA$", MOISTURE.map(elem).join("\n")));
    }

    fs.readFile(path.join(__dirname, "index.html"), {encoding: "utf-8"}, serve);
  }

  // Returns JSON of the current lighting system schedule
  function json(req, res) {
    res.json({ data: SCHEDULE });
  }

  // Set new lighting system schedule as submitted
  // by the web page using HTTP PUT
  function update(req, res) {
    updateSchedule(req.body);
    res.send("ok");
  }

  app.use(require("body-parser").json());

  app.get("/", index);
  app.get("/schedule", json);
  app.put("/schedule", update);
  app.get("/on", function(req, res) { turnOn(); res.send(""); });
  app.get("/off", function(req, res) { turnOff(); res.send(""); });

  app.listen(process.env.PORT || 3000);
}

// Log the moisture level every 15 minutes
function monitor() {
  setInterval(function() {
    var value = moisture.value();

    MOISTURE.push({ value: value, time: new Date().toISOString() });
    log("moisture (" + value + ")");

    if (MOISTURE.length > 20) { MOISTURE.shift(); }
  }, 1 * 30 * 1000);
}

// The main function calls `server()` to start up
// the built-in web server used to configure the
// lighting system's on/off times.
// It also calls the `monitor()` function which monitors
// the moisture data.
function main() {
  server();
  monitor();
}

main();
