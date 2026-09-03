import { IsNotEmpty, IsString } from "class-validator";




export class ResendVerficationOtpDto{
    @IsNotEmpty()
    @IsString()
    email!:string
}