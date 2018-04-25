import {Context, Robot} from "probot";
import {Task} from "./task";
import {AppConfig, appConfig, SizeConfig} from "../default";
import {getGhLabels, getLabelsNames, matchAllOfAny} from "./common";
import * as Github from '@octokit/rest';
import {STATUS_STATE} from "../typings";
import { HttpClient } from "../http";
import { Response } from "request";
import { database } from "firebase-admin";

export const CONFIG_FILE = "angular-robot.yml";

export interface CircleCiArtifact {
  path: string;
  pretty_path: string;
  node_index: number;
  url: string;
}

export interface BuildArtifact {
  sizeBytes: number;
  fullPath: string;
  contextPath: string[];
  projectName: string;
}

export interface BuildArtifactDiff {
  artifact: BuildArtifact;
  increase: number;
}
export interface CircleCiBuildSummary {
  vcs_revision: string;
  build_num: number;
}

export class SizeTask extends Task {
  constructor(robot: Robot, notUsedDb: FirebaseFirestore.Firestore, private readonly rtDb: database.Database, private readonly http: HttpClient) {
    super(robot, notUsedDb);
    this.dispatch([
      'status',
    ], this.checkSize.bind(this));
  }

  async checkSize(context: Context): Promise<any> {
    const config = await this.getConfig(context);
    if (config.disabled) {
      return;
    }
    
    // TODO: make context configurable
    if((context.payload.state !== STATUS_STATE.Success) || !context.payload.context.startsWith('ci/circleci')) {
      // do nothing since we only want succedded circleci events
      return;
    }
    const pr = await this.findCurrentPr(context.payload.sha, context.payload.repository.id);
    if(!pr) {
      // this status dosen't have a PR therefore it's probably a commit to a branch
      // so we want to store any chanegs from that commit
      this.storeArtifacts(context);
      // dont continue
      return;
    }

    // set to pending since we are going to do a full run through
    // TODO: can we set pending sooner? like at the start of the PR
    await this.setStatus(STATUS_STATE.Pending, 'Calculating artifact sizes', context, config);

    const {owner, repo} = context.repo();

    const buildNumber = this.getBuildNumberFromCircleCIUrl(context.payload.target_url);
    const newArtifacts = await this.getCircleCIArtifacts(owner, repo, buildNumber);

    const targetBranchArtifacts = await this.getTargetBranchArtifacts(pr);

    const largestIncrease = await this.findLagestIncrease(targetBranchArtifacts, newArtifacts);

    const failure = this.isFailure(config, largestIncrease.increase);

    if(failure) {
      const desc = `${largestIncrease.artifact.fullPath} increased by ${largestIncrease.increase} bytes`; // TODO pretty up bytes 
      await this.setStatus(STATUS_STATE.Failure, desc, context, config);
    } else {
      if(largestIncrease.increase === 0) {
        const desc = `no size change`;
        await this.setStatus(STATUS_STATE.Success, desc, context, config);      
      } else if (largestIncrease.increase < 0) {
        const desc = `${largestIncrease.artifact.fullPath} decreased by ${largestIncrease.increase} bytes`; // TODO pretty up bytes 
        await this.setStatus(STATUS_STATE.Success, desc, context, config); 
      }
    }
  }

  async findCurrentPr(sha: string, repositoryId: number) {
    let pr;
    const matches = (await this.pullRequests.where('head.sha', '==', sha)
      .where('repository.id', '==', repositoryId)
      .get());
    matches.forEach(async doc => {
      pr = doc.data();
    });
    return pr;
  }

  async storeArtifacts(context: Context) {
    const {owner, repo} = context.repo();
    const buildNumber = await this.getBuildNumberFromCircleCIUrl(context.payload.target_url);
    const newArtifacts = await this.getCircleCIArtifacts(owner, repo, buildNumber);
    await this.upsertNewArtifacts(context, newArtifacts);
  }

  async upsertNewArtifacts(context: Context, artifacts: BuildArtifact[]) {
    // eg: aio/gzip7/inline
    // eg: ivy/gzip7/inline
    // projects within this repo 
    const projects = new Set(artifacts.map(a => a.projectName));

    for(const project of projects) {
      for(const branch of context.payload.branches) {

        const ref =  this.rtDb.ref(`/payload/${project}/${branch.name}/${context.payload.commit.sha}`);
        const artifactsOutput = {
          change: 'application',
          message: context.payload.commit.commit.message,
          timestamp: new Date().getTime(),
        };
  
        // only use the artifacts from this project
        artifacts.filter(a => a.projectName === project)
          .forEach(a => {
            // hold a ref to where we are in our tree walk
            let lastNestedItemRef: object|number = artifactsOutput;
            // first item is the project name which we've used already 
            a.contextPath.forEach((path, i) => {
              // last item so assign it the bytes size
              if(i === a.contextPath.length - 1) {
                lastNestedItemRef[path] = a.sizeBytes;
                return;
              }
              if(!lastNestedItemRef[path]) {
                lastNestedItemRef[path] = {};
              }
  
              lastNestedItemRef = lastNestedItemRef[path];
            });
            lastNestedItemRef = a.sizeBytes;
          });     
        // if one already exists for this sha, override it
        await ref.set(artifactsOutput);
      }
    }
  }

  getBuildNumberFromCircleCIUrl(url: string): number {
    const parts = url.split('/');
    if(parts[2] === 'circleci.com' && parts[3] === 'gh') {
      return Number(parts[6].split('?')[0]);
    } else {
      throw new Error('incorrect circleci path');
    }
  }

  async setStatus(state: STATUS_STATE, desc: string, context: Context, config: SizeConfig): Promise<any> {
    const {owner, repo} = context.repo();

    const statusParams: Github.ReposCreateStatusParams = {
      owner,
      repo,
      sha: context.payload.sha,
      context: config.status.context,
      state,
      description: desc,
    };

    await context.github.repos.createStatus(statusParams);
  }

  isFailure(config: SizeConfig, increase: number): boolean {
    return increase > config.maxSizeIncrease ;
  }

  findLagestIncrease(oldArtifacts: BuildArtifact[], newArtifacts: BuildArtifact[]): BuildArtifactDiff {
    let largestIncrease: BuildArtifact = null;
    let largestIncreaseSize = 0;

    for(const newArtifact of newArtifacts) {
      const targetArtifact = oldArtifacts.find(a => a.fullPath === newArtifact.fullPath);
      let increase = 0;
      if (targetArtifact === null || targetArtifact === undefined) {
        increase = newArtifact.sizeBytes;
      } else {
        increase = newArtifact.sizeBytes - targetArtifact.sizeBytes;
      }
      if (increase > largestIncreaseSize || largestIncrease === null) {
        largestIncreaseSize = increase;
        largestIncrease = newArtifact;
      }
    }

    return {
     artifact: largestIncrease,
     increase: largestIncreaseSize
    };
  }

  async getTargetBranchArtifacts(prPayload: any): Promise<BuildArtifact[]> {
    const targetBranch = prPayload.base;

    const payloadValue = await this.rtDb.ref('/payload').once('value');
    const projects = Object.keys(payloadValue.val());

    const artifacts: BuildArtifact[] = [];
    for(const projectName of projects) {

      const ref = this.rtDb.ref(`/payload/${projectName}/${targetBranch.ref}/${targetBranch.sha}`);
      const snapshot = await ref.once('value');
      const value = snapshot.val();
      delete value.change;
      delete value.message;
      delete value.timestamp;

      // reconstruct the paths into artifacts
      const reconstructArtifacts = (object: any, path: string) => {
        Object.keys(object).forEach(k => {
          if(typeof object[k] === 'object') {
            reconstructArtifacts(object[k], path + '/' + k);
          } else {
            path = path + '/' + k;           
            const pathParts = path.split('/').slice(1); 
            artifacts.push({
              sizeBytes: object[k],
              fullPath: path ,
              projectName: projectName,
              contextPath: pathParts,
            });
          }
        });
      };
      reconstructArtifacts(value, projectName);
    }
    return artifacts;

  }

  async getCircleCIArtifacts(username: string, project: string, buildNumber: number): Promise<BuildArtifact[]> {
    const artifacts = await this.http.get<CircleCiArtifact[]>(`https://circleci.com/api/v1.1/project/github/${username}/${project}/${buildNumber}/artifacts`) as CircleCiArtifact[];

    return Promise.all(artifacts.map(async artifact => {
      const content = await this.http.get<string>(artifact.url, {responseType: 'response'} as any) as Response;
      const pathParts = artifact.path.split('/');
      return {
        fullPath: artifact.path, 
        projectName: pathParts[0],
        contextPath: pathParts.slice(1),
        sizeBytes: Number(content.headers["content-length"]),
      };
    }));

  }

  /**
   * Gets the config for the merge plugin from Github or uses default if necessary
   */
  async getConfig(context: Context): Promise<SizeConfig> {
    const repositoryConfig = await context.config<AppConfig>(CONFIG_FILE, appConfig);
    const config = repositoryConfig.size;
    return config;
  }
}
