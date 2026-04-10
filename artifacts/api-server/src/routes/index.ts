import { Router, type IRouter } from "express";
import healthRouter from "./health";
import authRouter from "./auth";
import usersRouter from "./users";
import clientsRouter from "./clients";
import engagementsRouter from "./engagements";
import deadlinesRouter from "./deadlines";
import checklistRouter from "./checklist";
import documentsRouter from "./documents";
import commentsRouter from "./comments";
import notificationsRouter from "./notifications";
import auditRouter from "./audit";
import dashboardRouter from "./dashboard";

const router: IRouter = Router();

router.use(healthRouter);
router.use(authRouter);
router.use(usersRouter);
router.use(clientsRouter);
router.use(engagementsRouter);
router.use(deadlinesRouter);
router.use(checklistRouter);
router.use(documentsRouter);
router.use(commentsRouter);
router.use(notificationsRouter);
router.use(auditRouter);
router.use(dashboardRouter);

export default router;
