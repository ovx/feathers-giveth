import LPPMilestone from 'lpp-milestone';
import { LPPMilestoneRuntimeByteCode } from 'lpp-milestone/build/LPPMilestone.sol';
import LPPCampaign from 'lpp-campaign';
import { deployedBytecode as LPPCampaignByteCode } from 'lpp-campaign/build/contracts/LPPCampaign.json';

import { campaignStatus, milestoneStatus } from './helpers';

const BreakSignal = () => {
};

/**
 * class to keep feathers cache in sync with liquidpledging admins
 */
class Admins {
  constructor(app, liquidPledging) {
    this.app = app;
    this.web3 = liquidPledging.$web3;
    this.liquidPledging = liquidPledging;
  }

  addGiver(event) {
    if (event.event !== 'GiverAdded') throw new Error('addGiver only handles GiverAdded events');

    const { returnValues } = event;

    this.liquidPledging.getPledgeAdmin(returnValues.idGiver)
      .then(giver => this._addGiver(giver, returnValues.idGiver))
      .catch(err => console.error('addGiver error ->', err)); //eslint-disable-line no-console
  }

  updateGiver(event) {
    if (event.event !== 'GiverUpdated') throw new Error('updateGiver only handles GiverUpdated events');

    const giverId = event.returnValues.idGiver;

    const users = this.app.service('/users');

    const getUser = () => {
      return users.find({ query: { giverId } })
        .then(({ data }) => {

          if (data.length === 0) {
            this.liquidPledging.getPledgeAdmin(giverId)
              .then(giver => this._addGiver(giver, giverId))
              .catch(err => console.error('updateGiver error ->', err)); //eslint-disable-line no-console
            throw new BreakSignal();
          }

          if (data.length > 1) {
            console.warn('more then 1 user with the same giverId found: ', data); // eslint-disable-line no-console
          }

          return data[ 0 ];
        });
    };

    Promise.all([ getUser(), this.liquidPledging.getPledgeAdmin(giverId) ])
      .then(([ user, giver ]) => {
        // If a giver changes address, update users to reflect the change.
        if (giver.addr !== user.address) {
          console.log(`giver address "${giver.addr}" differs from users address "${user.address}". Updating users to match`); // eslint-disable-line no-console
          users.patch(user.address, { $unset: { giverId: true } });
          return this._addGiver(giver, giverId);
        }

        return users.patch(user.address, { commitTime: giver.commitTime, name: giver.name });
      })
      .catch(err => {
        if (err instanceof BreakSignal) return;
        console.error('updateGiver error ->', err); // eslint-disable-line no-console
      });
  }


  _addGiver(giver, giverId) {
    const { commitTime, addr, name } = giver;
    const users = this.app.service('/users');

    return users.get(addr)
      .catch(err => {
        if (err.name === 'NotFound') {
          return users.create({
            address: addr,
          });
        }

        throw err;
      })
      .then(user => {
        if (user.giverId && user.giverId !== 0) {
          console.error(`user already has a giverId set. existing giverId: ${user.giverId}, new giverId: ${giverId}`);
        }
        return users.patch(user.address, { commitTime, name, giverId: giverId });
      })
      .then(user => {
        this._addPledgeAdmin(giverId, 'giver', user.address)
          .then(() => user);
      })
      .catch(err => console.error('_addGiver error ->', err));
  }


  //TODO support delegates other then dacs
  addDelegate(event) {
    if (event.event !== 'DelegateAdded') throw new Error('addDelegate only handles DelegateAdded events');

    this._addDelegate(event.returnValues.idDelegate, event.transactionHash);
  }

  updateDelegate(event) {
    if (event.event !== 'DelegateUpdated') throw new Error('updateDelegate only handles DelegateUpdated events');

    const delegateId = event.returnValues.idDelegate;

    const dacs = this.app.service('/dacs');

    const getDAC = () => {
      return dacs.find({ query: { delegateId } })
        .then(({ data }) => {

          if (data.length === 0) {
            this._addDelegate(delegateId);
            throw new BreakSignal();
          }

          if (data.length > 1) {
            console.warn('more then 1 dac with the same delegateId found: ', data); // eslint-disable-line no-console
          }

          return data[ 0 ];
        });
    };

    Promise.all([ getDAC(), this.liquidPledging.getPledgeAdmin(delegateId) ])
      .then(([ dac, delegate ]) => {
        return dacs.patch(dac._id, {
          ownerAddress: delegate.addr,
          title: delegate.name,
        });
      })
      .catch(err => {
        if (err instanceof BreakSignal) return;
        console.error('updateDelegate error ->', err); // eslint-disable-line no-console
      });
  }

  _addDelegate(delegateId, txHash, retry = false) {
    const dacs = this.app.service('/dacs');

    const findDAC = (delegate) => {
      return dacs.find({ query: { txHash } })
        .then(({ data }) => {

          if (data.length === 0) {
            if (!retry) {
              // this is really only useful when instant mining. Other then that, the dac should always be
              // created before the tx was mined.
              setTimeout(() => this._addDelegate(delegateId, txHash, true), 5000);
              throw new BreakSignal();
            }
            //TODO do we need to create an owner here?
            //TODO maybe don't create new dac as all creating is done via the ui? Do we want to show delegates added not via the ui?

            return dacs.create({
              ownerAddress: delegate.addr,
              title: delegate.name,
              totalDonated: '0',
              donationCount: 0,
              description: '',
            });
          }

          if (data.length > 1) {
            console.warn('more then 1 dac with the same ownerAddress and title found: ', data); // eslint-disable-line no-console
          }

          return data[ 0 ];
        });
    };

    return this.liquidPledging.getPledgeAdmin(delegateId)
      .then(delegate => Promise.all([ delegate, findDAC(delegate) ]))
      .then(([ delegate, dac ]) => dacs.patch(dac._id, {
        delegateId,
        ownerAddress: delegate.addr,
      }))
      .then(dac => {
        this._addPledgeAdmin(delegateId, 'dac', dac._id)
          .then(() => dac);
      })
      .catch(err => {
        if (err instanceof BreakSignal) return;
        console.error('_addDelegate error ->', err); //eslint-disable-line no-console
      });
  }


  addProject(event) {
    if (event.event !== 'ProjectAdded') throw new Error('addProject only handles ProjectAdded events');

    const projectId = event.returnValues.idProject;
    const txHash = event.transactionHash;

    return this.liquidPledging.getPledgeAdmin(projectId)
      .then(project => Promise.all([ project, this.web3.eth.getCode(project.plugin) ]))
      .then(([ project, byteCode ]) => {

        if (byteCode === LPPMilestoneRuntimeByteCode) return this._addMilestone(project, projectId, txHash);
        //TODO remove this after lpp-campaign uses solcpiler
        if (byteCode === LPPCampaignByteCode) return this._addCampaign(project, projectId, txHash);
        // if (byteCode === LPPCampaignByteCode) return this._addCampaign(project, projectId, txHash);

        console.error('AddProject event with unknown plugin byteCode ->', event); // eslint-disable-line no-console
      });
  }

  _addMilestone(project, projectId, txHash, retry = false) {
    const milestones = this.app.service('/milestones');
    const campaigns = this.app.service('/campaigns');

    const lppMilestone = new LPPMilestone(this.web3, project.plugin);

    // get_or_create campaign by projectId
    const findCampaign = (campaignProjectId) => {
      return campaigns.find({ query: { projectId: campaignProjectId } })
        .then(({ data }) => {

          // create a campaign if necessary
          if (data.length === 0) {
            //TODO do we need to create an owner here?

            return this.liquidPledging.getPledgeAdmin(campaignProjectId)
              .then(campaignProject => campaigns.create({
                ownerAddress: campaignProject.addr,
                title: campaignProject.name,
                projectId: campaignProjectId,
                totalDonated: '0',
                donationCount: 0,
              }))
              .then(campaign => campaign._id);
          }

          if (data.length > 1) {
            console.warn('more then 1 campaign with the same projectId found: ', data); // eslint-disable-line no-console
          }

          return data[ 0 ]._id;
        });
    };

    // get_or_create milestone by title and ownerAddress
    const findMilestone = () => {
      return milestones.find({ query: { txHash } })
        .then(({ data }) => {

          if (data.length === 0) {
            if (!retry) {
              // this is really only useful when instant mining. Other then that, the milestone should always be
              // created before the tx was mined.
              setTimeout(() => this._addMilestone(project, projectId, txHash, true), 5000);
              throw new BreakSignal();
            }
            //TODO do we need to create an owner here?

            return Promise.all([ findCampaign(project.parentProject), this.web3.eth.getTransaction(txHash) ])
              .then(([ campaignId, tx ]) => milestones.create({
                ownerAddress: tx.from,
                pluginAddress: project.plugin,
                title: project.name,
                description: '',
                txHash,
                campaignId,
                totalDonated: '0',
                donationCount: 0,
              }));
          }

          if (data.length > 1) {
            console.warn('more then 1 milestone with the same txHash found: ', data); // eslint-disable-line no-console
          }

          return data[ 0 ];
        });
    };

    return Promise.all([ findMilestone(), lppMilestone.maxAmount(), lppMilestone.reviewer(), lppMilestone.recipient(), lppMilestone.accepted(), lppMilestone.canceled() ])
      .then(([ milestone, maxAmount, reviewer, recipient, accepted, canceled ]) => milestones.patch(milestone._id, {
        projectId,
        maxAmount,
        reviewerAddress: reviewer,
        recipientAddress: recipient,
        title: project.name,
        pluginAddress: project.plugin,
        status: milestoneStatus(accepted, canceled),
        mined: true,
      }))
      .then(milestone => {
        this._addPledgeAdmin(projectId, 'milestone', milestone._id)
          .then(() => milestone);
      })
      .catch(err => {
        if (err instanceof BreakSignal) return;
        console.error('_addMilestone error ->', err); //eslint-disable-line no-console
      });
  }

  _addCampaign(project, projectId, txHash, retry = false) {
    const campaigns = this.app.service('/campaigns');

    // get_or_create campaign by title and ownerAddress
    const findCampaign = () => {
      return campaigns.find({ query: { txHash } })
        .then(({ data }) => {

          // create a campaign if necessary
          if (data.length === 0) {
            if (!retry) {
              // this is really only useful when instant mining. Other then that, the campaign should always be
              // created before the tx was mined.
              setTimeout(() => this._addCampaign(project, projectId, txHash, true), 5000);
              throw new BreakSignal();
            }

            return this.web3.eth.getTransaction(txHash)
              .then(tx => campaigns.create({
                ownerAddress: tx.from,
                pluginAddress: project.plugin,
                title: project.name,
                description: '',
                txHash,
                totalDonated: '0',
                donationCount: 0,
              }));
          }

          if (data.length > 1) {
            console.warn('more then 1 campaign with the same title and ownerAddress found: ', data); // eslint-disable-line no-console
          }

          return data[ 0 ];
        });
    };

    const lppCampaign = new LPPCampaign(this.web3, project.plugin);

    return Promise.all([ findCampaign(), lppCampaign.status(), lppCampaign.reviewer() ])
      .then(([ campaign, status, reviewer ]) => campaigns.patch(campaign._id, {
        projectId,
        title: project.name,
        reviewerAddress: reviewer,
        pluginAddress: project.plugin,
        status: campaignStatus(status),
      }))
      .then(campaign => {
        this._addPledgeAdmin(projectId, 'campaign', campaign._id)
          .then(() => campaign);
      })
      .catch(err => {
        if (err instanceof BreakSignal) return;
        console.error('_addCampaign error ->', err); //eslint-disable-line no-console
      });
  }

  updateProject(event) {
    if (event.event !== 'ProjectUpdated') throw new Error('updateProject only handles ProjectUpdated events');

    const projectId = event.returnValues.idProject;

    // we make the assumption that if there is a parentProject, then the project is a milestone, otherwise it is a campaign
    return this.liquidPledging.getPledgeAdmin(projectId)
      .then(project => {
        return (project.parentProject > 0) ? this._updateMilestone(project, projectId) : this._updateCampaign(project, projectId);
      });
  }

  _updateMilestone(project, projectId) {
    const milestones = this.app.service('/milestones');

    const getMilestone = () => {
      return milestones.find({ query: { projectId } })
        .then(({ data }) => {

          if (data.length === 0) {
            this._addMilestone(project, projectId);
            throw new BreakSignal();
          }

          if (data.length > 1) {
            console.warn('more then 1 milestone with the same projectId found: ', data); // eslint-disable-line no-console
          }

          return data[ 0 ];
        });
    };

    return getMilestone()
      .then((milestone) => {
        return milestones.patch(milestone._id, {
          // ownerAddress: project.addr, // TODO project.addr is the milestone contract, need to fix
          title: project.name,
        });
      })
      .catch(err => {
        if (err instanceof BreakSignal) return;
        console.error('_updateMilestone error ->', err); // eslint-disable-line no-console
      });
  }

  _updateCampaign(project, projectId) {
    const campaigns = this.app.service('/campaigns');

    const getCampaign = () => {
      return campaigns.find({ query: { projectId } })
        .then(({ data }) => {

          if (data.length === 0) {
            this._addCampaign(project, projectId);
            throw new BreakSignal();
          }

          if (data.length > 1) {
            console.warn('more then 1 campaign with the same projectId found: ', data); // eslint-disable-line no-console
          }

          return data[ 0 ];
        });
    };

    return getCampaign()
      .then((campaign) => {
        return campaigns.patch(campaign._id, {
          ownerAddress: project.addr,
          title: project.name,
        });
      })
      .catch(err => {
        if (err instanceof BreakSignal) return;
        console.error('_updateCampaign error ->', err); // eslint-disable-line no-console
      });
  }


  _addPledgeAdmin(id, type, typeId) {
    const pledgeAdmins = this.app.service('pledgeAdmins');

    return pledgeAdmins.create({ id, type, typeId })
      .catch(err => {
        // TODO if the pledgeAdmin already exists, then verify the type and typeId and return the admin
        console.log('create pledgeAdmin error =>', err);
      });
  }
}

export default Admins;