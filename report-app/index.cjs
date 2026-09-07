// Docker entrypoint: run the web server and the daily-email scheduler in one process.
require('./server.cjs');
require('./scheduler.cjs');
