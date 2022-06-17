#!/bin/bash

dockerd-entrypoint.sh &

sleep 5

npm start

wait
