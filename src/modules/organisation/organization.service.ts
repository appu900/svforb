import { Logger,Injectable, NotFoundException } from "@nestjs/common";
import { NotFoundError } from "rxjs";
import { PrismaService } from "src/infra/prisma/prisma.service";

@Injectable()
export class OrganisationService{
  private readonly logger = new Logger(OrganisationService.name)
  constructor(private readonly prisma: PrismaService) { }


  async updateOrganizationLocation(dto: any, organizationId: number) {
    const organization = await this.prisma.organisation.findUnique({
      where:{id:organizationId},
      select:{
        longitude:true,
        latitude:true
      }
    })
    if(organization){
      return new NotFoundException('Organization not found')
    }
    const updatedOrganization = await this.prisma.organisation.update({
      where:{id:organizationId},
      data:{
        longitude:dto.longitude,
        latitude:dto.latitude
      }
    })
    return updatedOrganization
  }
}