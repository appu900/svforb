import { Logger } from "@nestjs/common";

interface UserSignupDto{
  username: string
  password:string
}

export class UserController{
  private readonly logger = new Logger(UserController.name)


  async create(data: UserSignupDto) {
    
  }
}