const express = require('express');
const bodyParser = require('body-parser');
const {Op} = require("sequelize");
const {sequelize} = require('./model')
const {getProfile} = require('./middleware/getProfile')
const app = express();
app.use(bodyParser.json());
app.set('sequelize', sequelize)
app.set('models', sequelize.models)

/**
 * @returns contract by id
 */
app.get('/contracts/:id',getProfile ,async (req, res) =>{
    const {Contract} = req.app.get('models')
    const {id} = req.params

    try {
      const contract = await Contract.findOne({
        where: {id},
        attributes: ['terms', 'status'],
        raw: true
      })
      
      if(req.profile.type === 'client' && contract.ClientId === req.profile.id) {
        return res.json(contract)
      }
      
      if(req.profile.type === 'contractor' && contract.ContractorId === req.profile.id) {
        return res.json(contract)
      }
      
      res.status(404).end()
    } catch (error) {
      console.error(error);
      res.status(500).json({ error: 'Internal Server Error' });
    }
})

/**
 * @returns list of contracts
 */
app.get('/contracts',getProfile ,async (req, res) =>{
    const {Contract} = req.app.get('models')
    const {id} = req.profile

    try {
      const contracts = await Contract.findAll({
        where: {
          [Op.or]: [
            { ClientId: id },
            { ContractorId: id },
          ],
          status: {
            [Op.not]: 'terminated'
          }
        },
        attributes: ['terms', 'status'],
      })
      
      if(contracts.length === 0) return res.status(404).end()
      
      res.json(contracts)
    } catch (error) {
      console.error(error);
      res.status(500).json({ error: 'Internal Server Error' });
    }
})

/**
 * @returns list of unpaid jobs
 */
app.get('/jobs/unpaid',getProfile ,async (req, res) =>{
    const {Job, Contract} = req.app.get('models')
    const {id} = req.profile

    try {
      const jobs = await Job.findAll({
        where: {
          paid: false,
        },
        include: [
          {
            model: Contract,
            where: {
              status: 'in_progress',
              [Op.or]: [
                { ClientId: id },
                { ContractorId: id }
              ],
            },
            attributes: ['terms', 'status'],
          },
        ],
        attributes: ['description', 'price'],
      });
      
      if(jobs.length === 0) return res.status(404).end()
      
      res.json(jobs)
    } catch (error) {
      console.error(error);
      res.status(500).json({ error: 'Internal Server Error' });
    }
})

/**
 * Pay for a job
 */
app.post('/jobs/:job_id/pay',getProfile ,async (req, res) =>{
    const {Job, Contract, Profile} = req.app.get('models')
    const {job_id} = req.params
    const {id} = req.profile

    try {
      await sequelize.transaction(async (t) => {
        const job = await Job.findByPk(job_id, { transaction: t, include: [Contract] });

        if (!job) {
          throw new Error('Job not found');
        }
        if (job.dataValues.paid) {
          throw new Error('Already paid');
        }

        const contractorId = job.dataValues.Contract.dataValues.ContractorId;
        const clientId = job.dataValues.Contract.dataValues.ClientId;
        const client = await Profile.findByPk(clientId, { transaction: t });
        const contractor = await Profile.findByPk(contractorId, { transaction: t });

        if (clientId !== id) {
          throw new Error('Wrong job id');
        }

        const amountToPay = job.dataValues.price;
  
        if (client.balance < amountToPay) {
          throw new Error(`Client's balance is insufficient for payment`);
        }
  
        client.balance -= amountToPay;
        contractor.balance += amountToPay;
  
        job.paid = true;
        job.paymentDate = new Date();

        await Promise.all([client.save({ transaction: t }), contractor.save({ transaction: t }), job.save({ transaction: t })]);
      });
    
      res.status(200).json({ message: 'Payment successful' });
    } catch (error) {

      console.error('Error:', error);
      res.status(400).json({ error: error.message });
    }
})

/**
 * Deposits money into the balance of a client
 */
app.post('/balances/deposit/:userId', async (req, res) =>{
    const {Job, Contract, Profile} = req.app.get('models')
    const {userId} = req.params
    const {depositAmount} = req.body;

    try {
      await sequelize.transaction(async (t) => {
        const client = await Profile.findByPk(userId, { transaction: t });

        if (!client) {
          throw new Error('Client not found');
        }
  
        const outstandingJobsAmount = await Job.sum('price', {
          where: {
            paid: false,
            '$Contract.ClientId$': userId,
          },
          include: [{ model: Contract }],
          transaction: t,
        });

        const maxDepositProcent = 0.25; 
        const maxDepositAmount = maxDepositProcent * outstandingJobsAmount;
  
        if (depositAmount > maxDepositAmount) {
          throw new Error('Deposit amount exceeds the maximum allowed');
        }
  
        client.balance += depositAmount;
  
        await client.save({ transaction: t });
      });
  
      res.status(200).json({ message: 'Deposit successful' });
    } catch (error) {
      console.error('Error:', error);
      res.status(400).json({ error: error.message });
    }
})

/**
 * @returns profession that earned the most money
 */
app.get('/admin/best-profession',getProfile ,async (req, res) =>{
  const { start, end } = req.query;

  if (!start || !end) {
    return res.status(400).json({ error: 'Both start and end parameters are required' });
  }

  try {
    const result = await sequelize.query(`
      SELECT 
        contractor.profession,
        SUM(jobs.price) AS earnings
      FROM contracts AS contract
      INNER JOIN profiles AS contractor ON contract.contractorId = contractor.id
      INNER JOIN jobs AS jobs ON contract.id = jobs.contractId
      WHERE jobs.paymentDate BETWEEN :start AND :end
      GROUP BY contractor.profession
      ORDER BY earnings DESC
      LIMIT 1;
    `, {
      replacements: { start, end },
      type: sequelize.QueryTypes.SELECT,
    });

    if (result.length > 0) {
      res.json({ bestProfession: result[0].profession });
    } else {
      res.json({ message: 'No data found for the specified time range' });
    }
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
})

/**
 * @returns clients the paid the most for jobs
 */
app.get('/admin/best-clients',getProfile ,async (req, res) =>{
  const { start, end, limit } = req.query;

  if (!start || !end) {
    return res.status(400).json({ error: 'Both start and end parameters are required' });
  }

  const queryLimit = limit ? parseInt(limit, 10) : 2;

  try {
    const results = await sequelize.query(`
      SELECT 
        client.id,
        client.firstName || ' ' || client.lastName AS fullName,
        SUM(jobs.price) AS paid
      FROM jobs
      INNER JOIN contracts AS contract ON jobs.contractId = contract.id
      INNER JOIN profiles AS client ON contract.clientId = client.id
      WHERE contract.createdAt BETWEEN :start AND :end
      GROUP BY client.id, client.firstName, client.lastName
      ORDER BY paid DESC
      LIMIT :queryLimit;
    `, {
      replacements: { start, end, queryLimit },
      type: sequelize.QueryTypes.SELECT,
    });

    res.json(results);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
})

module.exports = app;
