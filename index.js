'use strict';

const _ = require('lodash');
const Dynalite = require('dynalite');
const chokidar = require('graceful-chokidar');
const AWS = require('aws-sdk');

const DEFAULT_PORT = 4567;
const DEFAULT_REGION = 'localhost';

const PORT_OPTIONS = {
    shortcut: 'p',
    usage: `the port number that dynalite will listen on (default ${ DEFAULT_PORT })`
};

class ServerlessPluginDynalite {

    constructor(serverless, options) {

        console.log(Object.keys(serverless));

        this.serverless = serverless;
        this.service = serverless.service;

        this.log = serverless.cli.log.bind(serverless.cli);
        this.config = this.service.custom && this.service.custom.dynalite || {};
        this.options = options;

        this.commands = {
            dynalite: {
                start: {
                    usage: 'start a persistent dynalite server',
                    lifecycleEvents: [ 'startHandler' ],
                    options: {
                        port: PORT_OPTIONS
                    }
                },
                watch: {
                    usage: 'start dynalite and watch for table definition changes',
                    lifecycleEvents: [ 'watchHandler' ],
                    options: {
                        port: PORT_OPTIONS
                    }
                }
            }
        };

        this.hooks = {
            "dynalite:start:startHandler": this.startHandler.bind(this),
            "dynalite:watch:watchHandler": this.watchHandler.bind(this),
            "before:offline:start:init": this.startHandler.bind(this),
            "before:offline:start:end": this.endHandler.bind(this)
        };
    }

    get port() {
        return _.get(this, ['config', 'start', 'port'], DEFAULT_PORT);
    }

    get region() {
        return _.get(this, ['config', 'start', 'region'], DEFAULT_REGION);
    }

    get dynamodb() {

        if (this._dynamodb) {
            return this._dynamodb;
        }

        const dynamoOptions = {
            endpoint: `http://localhost:${this.port}`,
            region: this.region
        };

        this._dynamodb = {
            raw: new AWS.DynamoDB(dynamoOptions),
            doc: new AWS.DynamoDB.DocumentClient(dynamoOptions)
        };

        return this._dynamodb;
    }

    async watchHandler() {
        await this.startHandler();

        this.watcher = chokidar.watch('./serverless.yml', { persistent: true, interval: 1000 })
            .on('change', () => {
                this.log('serverless.yml changed, updating...');
                this.updateTables();
            });
    }

    async startHandler() {
        this.dynalite = Dynalite({ createTableMs: 0 });
        await new Promise(
            (res, rej) => this.dynalite.listen(port, err => err ? rej(err) : res())
        );

        return this.updateTables();
    }

    endHandler() {
        if (this.watcher) {
            this.watcher.close();
        }

        if (this.dynalite) {
            this.dynalite.close();
        }
    }

    async updateTables() {
        const requiredTables = _.map(
            _.filter(
                _.values(
                    _.get(this.service, ['resources', 'Resources'], {})
                ),
                { 'Type': 'AWS::DynamoDB::Table' }
            ),
            'Properties'
        );
        this.log('Tables in config: ', requiredTables);

        const currentTables = await this.dynamodb.listTables({}).promise();
        this.log('Current Tables: ', currentTables.TableNames);

        const missingTables = _.reject(requiredTables,
            ({ TableName }) => _.includes(currentTables.TableNames, TableName)
        );
        this.log('Missing Tables: ', _.map(missingTables, 'TableName'));

        _.forEach(missingTables, async table => {
            this.log(`Creating table ${ table.TableName }...`);
            await this.dynamodb.createTable(table).promise();
        });

        const finalTables = await this.dynamodb.listTables({}).promise();
        this.log('Current Tables: ', finalTables.TableNames);
    }
}

module.exports = ServerlessPluginDynalite;
